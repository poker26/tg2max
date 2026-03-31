import * as Minio from "minio";
import { config } from "./config.js";

const endpointUrl = new URL(config.minio.endpoint);
const customPort = endpointUrl.port ? parseInt(endpointUrl.port, 10) : undefined;

const clientOptions = {
  endPoint: endpointUrl.hostname,
  useSSL: endpointUrl.protocol === "https:",
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
};

if (customPort !== undefined) {
  clientOptions.port = customPort;
}

export const minioClient = new Minio.Client(clientOptions);

export async function uploadBufferToMinio(buffer, objectKey, contentType = "image/jpeg") {
  await minioClient.putObject(
    config.minio.bucketMedia,
    objectKey,
    buffer,
    buffer.length,
    { "Content-Type": contentType }
  );
  return objectKey;
}

export async function downloadBufferFromMinio(bucketName, objectKey) {
  const stream = await minioClient.getObject(bucketName, objectKey);
  return streamToBuffer(stream);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
