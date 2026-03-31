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

async function sendMessageViaMessagesEndpoint(chatId, text) {
  return requestMaxApi("POST", "/messages", {
    queryParams: { chat_id: chatId },
    jsonBody: { text },
  });
}

async function sendMessageViaChatEndpoint(chatId, text) {
  const normalizedChatId = encodeURIComponent(String(chatId).trim());
  return requestMaxApi("POST", `/chats/${normalizedChatId}/messages`, {
    jsonBody: { text },
  });
}

export async function publishToMaxChat({ chatId, message }) {
  const normalizedMessage = String(message ?? "").trim();
  if (!normalizedMessage) {
    throw new Error("Cannot publish an empty message to Max");
  }

  try {
    const response = await sendMessageViaMessagesEndpoint(chatId, normalizedMessage);
    return {
      messageId:
        response?.message_id ??
        response?.id ??
        response?.message?.message_id ??
        null,
      endpoint: "/messages?chat_id",
    };
  } catch (firstError) {
    const fallbackResponse = await sendMessageViaChatEndpoint(chatId, normalizedMessage);
    return {
      messageId:
        fallbackResponse?.message_id ??
        fallbackResponse?.id ??
        fallbackResponse?.message?.message_id ??
        null,
      endpoint: `/chats/${chatId}/messages`,
      fallbackFrom: firstError.message,
    };
  }
}
