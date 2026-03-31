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
      payload && typeof payload === "object" && "message" in payload
        ? payload.message
        : responseText;
    throw new Error(`MAX API ${method} ${path} failed (${response.status}): ${errorDetails}`);
  }

  return payload;
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

async function sendMessageViaMessagesEndpoint(chatId, messageBody) {
  return requestMaxApi("POST", "/messages", {
    queryParams: { chat_id: chatId },
    jsonBody: messageBody,
  });
}

async function sendMessageViaChatEndpoint(chatId, messageBody) {
  const normalizedChatId = encodeURIComponent(String(chatId).trim());
  return requestMaxApi("POST", `/chats/${normalizedChatId}/messages`, {
    jsonBody: messageBody,
  });
}

export async function uploadImageToMax(photoBuffer, filename = "photo.jpg") {
  const uploadMeta = await requestMaxApi("POST", "/uploads", {
    queryParams: { type: "image" },
  });

  const uploadUrl = uploadMeta?.url;
  if (!uploadUrl) {
    throw new Error("MAX /uploads did not return upload url");
  }

  const formData = new FormData();
  const blob = new Blob([photoBuffer], { type: "image/jpeg" });
  formData.append("data", blob, filename);

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: getMaxBotToken() },
    body: formData,
  });

  const uploadResponseText = await uploadResponse.text();
  let uploadPayload;
  try {
    uploadPayload = uploadResponseText ? JSON.parse(uploadResponseText) : null;
  } catch {
    uploadPayload = uploadResponseText;
  }

  if (!uploadResponse.ok) {
    throw new Error(
      `MAX upload failed (${uploadResponse.status}): ${
        typeof uploadPayload === "string" ? uploadPayload : JSON.stringify(uploadPayload)
      }`
    );
  }

  const uploadToken = uploadPayload?.token ?? uploadMeta?.token;
  if (!uploadToken) {
    throw new Error("MAX image upload did not return token");
  }

  return uploadToken;
}

async function sendMessageWithFallback(chatId, messageBody) {
  try {
    const response = await sendMessageViaMessagesEndpoint(chatId, messageBody);
    return { response, endpoint: "/messages?chat_id" };
  } catch (firstError) {
    const response = await sendMessageViaChatEndpoint(chatId, messageBody);
    return { response, endpoint: `/chats/${chatId}/messages`, fallbackFrom: firstError.message };
  }
}

export async function publishToMaxChat({ chatId, message, imageToken = null }) {
  const normalizedMessage = String(message ?? "").trim();
  if (!normalizedMessage && !imageToken) {
    throw new Error("Cannot publish an empty message to Max");
  }

  const messageBody = {
    text: normalizedMessage || undefined,
  };
  if (imageToken) {
    messageBody.attachments = [
      {
        type: "image",
        payload: { token: imageToken },
      },
    ];
  }

  const retryDelaysMs = [1200, 2500, 5000];
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < retryDelaysMs.length + 1; attemptIndex++) {
    try {
      const transportResult = await sendMessageWithFallback(chatId, messageBody);
      const response = transportResult.response;
      return {
        messageId: response?.message_id ?? response?.id ?? response?.message?.message_id ?? null,
        endpoint: transportResult.endpoint,
        fallbackFrom: transportResult.fallbackFrom,
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
