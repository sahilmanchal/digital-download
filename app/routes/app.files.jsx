import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const UPLOAD_DIR = join(process.cwd(), "uploads");

async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await mkdir(UPLOAD_DIR, { recursive: true });
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureUploadDir();

  try {
    const files = await prisma.file.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
    });

    return { files };
  } catch (error) {
    console.error("Error loading files:", error);
    return { files: [], error: error.message };
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureUploadDir();

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upload") {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return { error: "No file provided" };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = `${Date.now()}-${file.name}`;
    const filePath = join(UPLOAD_DIR, filename);

    await writeFile(filePath, buffer);

    const fileRecord = await prisma.file.create({
      data: {
        filename,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        path: filePath,
        shop: session.shop,
      },
    });

    return { success: true, file: fileRecord };
  }

  if (intent === "delete") {
    const fileId = formData.get("fileId");
    if (!fileId) {
      return { error: "No file ID provided" };
    }

    const fileRecord = await prisma.file.findFirst({
      where: { id: fileId, shop: session.shop },
    });

    if (!fileRecord) {
      return { error: "File not found" };
    }

    try {
      if (existsSync(fileRecord.path)) {
        await unlink(fileRecord.path);
      }
    } catch (error) {
      console.error("Error deleting file:", error);
    }

    await prisma.file.delete({
      where: { id: fileId },
    });

    return { success: true };
  }

  return { error: "Invalid intent" };
};

export default function Files() {
  const { files } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.file) {
      shopify.toast.show("File uploaded successfully");
      setUploading(false);
    }
    if (fetcher.data?.success && fetcher.formData?.get("intent") === "delete") {
      shopify.toast.show("File deleted successfully");
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setUploading(false);
    }
  }, [fetcher.data, shopify]);

  const handleFileUpload = async (event) => {
    const fileInput = event.target;
    const file = fileInput.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("intent", "upload");

    fetcher.submit(formData, {
      method: "POST",
      encType: "multipart/form-data",
    });
    fileInput.value = "";
  };

  const handleDelete = (fileId) => {
    if (!confirm("Are you sure you want to delete this file?")) return;

    const formData = new FormData();
    formData.append("intent", "delete");
    formData.append("fileId", fileId);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleDownload = (file) => {
    window.location.href = `/app/files/${file.id}/download`;
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <s-page heading="File Manager">
      <div slot="primary-action">
        <input
          id="file-upload"
          type="file"
          style={{ display: "none" }}
          onChange={handleFileUpload}
          disabled={uploading}
        />
        <s-button
          onClick={() => document.getElementById("file-upload")?.click()}
          disabled={uploading}
          loading={uploading}
        >
          Upload File
        </s-button>
      </div>

      <s-section heading="Files">
        {files.length === 0 ? (
          <s-paragraph>
            <s-text>
              No files uploaded yet. Click "Upload File" to get started.
            </s-text>
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {files.map((file) => (
              <s-box
                key={file.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" gap="base" align="space-between">
                    <s-stack direction="block" gap="tight">
                      <s-heading size="small">{file.originalName}</s-heading>
                      <s-text tone="subdued">
                        {formatFileSize(file.size)} • {file.mimeType} •{" "}
                        {formatDate(file.createdAt)}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="tight">
                      <s-button
                        variant="secondary"
                        onClick={() => handleDownload(file)}
                      >
                        Download
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => handleDelete(file.id)}
                        disabled={fetcher.state !== "idle"}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="File Manager">
        <s-paragraph>
          <s-text>
            Upload and manage your digital files. Files are stored securely and
            can be downloaded or deleted at any time.
          </s-text>
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Upload files up to 100MB</s-list-item>
          <s-list-item>Download files anytime</s-list-item>
          <s-list-item>Delete files you no longer need</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
