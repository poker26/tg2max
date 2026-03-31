import { config } from "../config.js";

export async function callVkApi(method, params = {}) {
  const body = new URLSearchParams({
    ...params,
    access_token: config.max.accessToken,
    v: config.max.apiVersion,
  });

  const response = await fetch(`${config.max.apiBaseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      `VK API ${method} error ${payload.error.error_code}: ${payload.error.error_msg}`
    );
  }

  return payload.response;
}

export async function uploadWallPhoto(photoBuffer, filename = "photo.jpg") {
  const uploadServer = await callVkApi("photos.getWallUploadServer", {
    group_id: config.max.groupId,
  });

  const formData = new FormData();
  const blob = new Blob([photoBuffer], { type: "image/jpeg" });
  formData.append("photo", blob, filename);

  const uploadResponse = await fetch(uploadServer.upload_url, {
    method: "POST",
    body: formData,
  });
  const uploadPayload = await uploadResponse.json();
  if (!uploadPayload.photo || uploadPayload.photo === "[]") {
    throw new Error("Failed to upload photo to VK upload server");
  }

  const saved = await callVkApi("photos.saveWallPhoto", {
    group_id: config.max.groupId,
    photo: uploadPayload.photo,
    server: uploadPayload.server,
    hash: uploadPayload.hash,
  });

  const photo = saved[0];
  return `photo${photo.owner_id}_${photo.id}`;
}

export async function publishToMax({ message, attachments = [] }) {
  const params = {
    owner_id: `-${config.max.groupId}`,
    from_group: 1,
    message,
  };
  if (attachments.length > 0) {
    params.attachments = attachments.join(",");
  }

  const result = await callVkApi("wall.post", params);
  return { postId: result.post_id };
}
