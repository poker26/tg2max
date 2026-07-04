import { config } from "../config.js";

function getMaxBotToken() {
  const token = config.max.botToken?.trim();
  if (!token) {
    throw new Error("MAX_BOT_TOKEN is not configured");
  }
  return token;
}

async function requestMaxApi(method, path, { queryParams = null, jsonBody = null } = {}) {
  const url = new URL(`${config.max.apiBaseUrl}${path}`);
  if (queryParams && typeof queryParams === "object") {
    for (const [queryName, queryValue] of Object.entries(queryParams)) {
      if (queryValue == null || queryValue === "") continue;
      url.searchParams.set(queryName, String(queryValue));
    }
  }

  const headers = {
    Authorization: getMaxBotToken(),
    Accept: "application/json",
  };
  if (jsonBody !== null) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: jsonBody !== null ? JSON.stringify(jsonBody) : undefined,
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = responseText;
  }

  if (!response.ok) {
    const errorDetails =
      typeof payload === "string"
        ? payload
        : JSON.stringify(payload ?? { message: responseText });
    throw new Error(`MAX API ${method} ${path} failed (${response.status}): ${errorDetails}`);
  }

  return payload;
}

function isRetryableMaxRequestError(error) {
  const errorText = String(error?.message ?? "").toLowerCase();
  return (
    errorText.includes("(429)") ||
    errorText.includes("(500)") ||
    errorText.includes("(502)") ||
    errorText.includes("(503)") ||
    errorText.includes("(504)") ||
    errorText.includes("timeout") ||
    errorText.includes("econnreset")
  );
}

async function requestMaxApiWithRetry(
  method,
  path,
  { queryParams = null, jsonBody = null } = {},
  { maxAttempts = 4, baseDelayMs = 1200 } = {}
) {
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    try {
      return await requestMaxApi(method, path, { queryParams, jsonBody });
    } catch (error) {
      lastError = error;
      const hasMoreAttempts = attemptIndex < maxAttempts - 1;
      if (!hasMoreAttempts || !isRetryableMaxRequestError(error)) {
        break;
      }
      const backoffMs = baseDelayMs * (attemptIndex + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

export async function getMaxBotMe() {
  return requestMaxApi("GET", "/me");
}

function extractMaxApiErrorCode(error) {
  const message = String(error?.message || "");
  const match = message.match(/"code"\s*:\s*"([^"]+)"/);
  if (match) {
    return match[1];
  }
  return "";
}

function findTokenRecursively(payload, depth = 0) {
  if (payload == null || depth > 8) {
    return null;
  }

  if (typeof payload === "string") {
    const trimmedValue = payload.trim();
    if (trimmedValue.length > 12 && !trimmedValue.startsWith("{") && !trimmedValue.startsWith("[")) {
      return trimmedValue;
    }
    return null;
  }

  if (typeof payload !== "object") {
    return null;
  }

  if ("token" in payload && typeof payload.token === "string" && payload.token.trim() !== "") {
    return payload.token.trim();
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nestedToken = findTokenRecursively(entry, depth + 1);
        if (nestedToken) {
          return nestedToken;
        }
      }
      continue;
    }

    const nestedToken = findTokenRecursively(value, depth + 1);
    if (nestedToken) {
      return nestedToken;
    }
  }

  return null;
}

async function sendMessageViaMessagesEndpoint(chatId, messageBody) {
  return requestMaxApi("POST", "/messages", {
    queryParams: { chat_id: chatId },
    jsonBody: messageBody,
  });
}

function mapMediaKindToUploadType(mediaKind) {
  if (mediaKind === "video") return "video";
  if (mediaKind === "file") return "file";
  return "image";
}

function mapMediaKindToAttachmentType(mediaKind) {
  if (mediaKind === "video") return "video";
  if (mediaKind === "file") return "file";
  return "image";
}

export async function uploadMediaToMax({ mediaBuffer, filename, mimeType, mediaKind = "image" }) {
  const uploadType = mapMediaKindToUploadType(mediaKind);
  const uploadMeta = await requestMaxApi("POST", "/uploads", {
    queryParams: { type: uploadType },
  });

  const uploadUrl = uploadMeta?.url;
  if (!uploadUrl) {
    throw new Error("MAX /uploads did not return upload url");
  }

  const formData = new FormData();
  const blob = new Blob([mediaBuffer], {
    type: mimeType || (mediaKind === "video" ? "video/mp4" : "image/jpeg"),
  });
  formData.append("data", blob, filename || "media.bin");

  let uploadPayload = null;
  let uploadFailedError = null;
  const uploadRetryDelaysMs = [0, 1500, 4000];
  for (let uploadAttempt = 0; uploadAttempt < uploadRetryDelaysMs.length; uploadAttempt++) {
    if (uploadAttempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, uploadRetryDelaysMs[uploadAttempt]));
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: getMaxBotToken() },
      body: formData,
    });

    const uploadResponseText = await uploadResponse.text();
    try {
      uploadPayload = uploadResponseText ? JSON.parse(uploadResponseText) : null;
    } catch {
      uploadPayload = uploadResponseText;
    }

    if (uploadResponse.ok) {
      uploadFailedError = null;
      break;
    }

    uploadFailedError = new Error(
      `MAX upload failed (${uploadResponse.status}): ${
        typeof uploadPayload === "string" ? uploadPayload : JSON.stringify(uploadPayload)
      }`
    );
  }

  if (uploadFailedError) {
    throw uploadFailedError;
  }

  const uploadToken =
    uploadMeta?.token ??
    findTokenRecursively(uploadPayload) ??
    findTokenRecursively(uploadMeta);

  if (!uploadToken) {
    const compactMeta =
      typeof uploadMeta === "string" ? uploadMeta : JSON.stringify(uploadMeta)?.slice(0, 500);
    const compactUpload =
      typeof uploadPayload === "string" ? uploadPayload : JSON.stringify(uploadPayload)?.slice(0, 500);
    throw new Error(
      `MAX image upload did not return token. uploadMeta=${compactMeta}; uploadResponse=${compactUpload}`
    );
  }

  return uploadToken;
}

export async function publishToMaxChat({ chatId, message, attachments = [] }) {
  const normalizedMessage = String(message ?? "").trim();
  if (!normalizedMessage && attachments.length === 0) {
    throw new Error("Cannot publish an empty message to Max");
  }

  const messageBody = {
    text: normalizedMessage || undefined,
  };
  if (attachments.length > 0) {
    messageBody.attachments = attachments.map((attachment) => ({
      type: mapMediaKindToAttachmentType(attachment.mediaKind),
      payload: { token: attachment.token },
    }));
  }

  const retryDelaysMs = [1200, 2500, 5000];
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < retryDelaysMs.length + 1; attemptIndex++) {
    try {
      const response = await sendMessageViaMessagesEndpoint(chatId, messageBody);
      return {
        messageId: response?.message_id ?? response?.id ?? response?.message?.message_id ?? null,
        endpoint: "/messages?chat_id",
      };
    } catch (error) {
      lastError = error;
      const maxErrorCode = extractMaxApiErrorCode(error);
      const hasMoreAttempts = attemptIndex < retryDelaysMs.length;
      if (maxErrorCode !== "attachment.not.ready" || !hasMoreAttempts) {
        break;
      }
      const delayMs = retryDelaysMs[attemptIndex];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export async function editMessageInMaxChat({ chatId, messageId, message }) {
  const text = String(message ?? "").trim();
  if (!text) {
    throw new Error("Cannot edit Max message with empty text");
  }

  const editPayload = await requestMaxApiWithRetry(
    "PATCH",
    `/messages/${encodeURIComponent(String(messageId))}`,
    {
      queryParams: { chat_id: chatId },
      jsonBody: { text },
    }
  );

  return {
    messageId:
      editPayload?.message_id ??
      editPayload?.id ??
      editPayload?.message?.message_id ??
      String(messageId),
  };
}

export async function deleteMessageInMaxChat({ chatId, messageId }) {
  await requestMaxApiWithRetry("DELETE", `/messages/${encodeURIComponent(String(messageId))}`, {
    queryParams: { chat_id: chatId },
  });
}
