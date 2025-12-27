import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const UPLOAD_DIR = join(process.cwd(), "uploads");

export async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true });
  }
}

export async function saveFile(file, buffer) {
  await ensureUploadDir();
  const filename = `${Date.now()}-${file.name}`;
  const filePath = join(UPLOAD_DIR, filename);
  await writeFile(filePath, buffer);
  return { filename, filePath };
}

export async function deleteFile(filePath) {
  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}

export async function readFileBuffer(filePath) {
  return await readFile(filePath);
}
