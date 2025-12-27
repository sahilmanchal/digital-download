import { existsSync } from "fs";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readFileBuffer } from "../files.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const fileRecord = await prisma.file.findFirst({
    where: { id, shop: session.shop },
  });

  if (!fileRecord) {
    throw new Response("File not found", { status: 404 });
  }

  if (!existsSync(fileRecord.path)) {
    throw new Response("File not found on disk", { status: 404 });
  }

  const fileBuffer = await readFileBuffer(fileRecord.path);

  return new Response(fileBuffer, {
    headers: {
      "Content-Type": fileRecord.mimeType,
      "Content-Disposition": `attachment; filename="${fileRecord.originalName}"`,
      "Content-Length": fileRecord.size.toString(),
    },
  });
};
