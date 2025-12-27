import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;

  const folder = await prisma.folder.findFirst({
    where: { id, shop: session.shop },
    include: {
      files: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!folder) {
    throw new Response("Folder not found", { status: 404 });
  }

  return { files: folder.files };
};
