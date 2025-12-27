import { useState, useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureUploadDir, saveFile, deleteFile } from "../files.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureUploadDir();

  try {
    const [folders, files] = await Promise.all([
      prisma.folder.findMany({
        where: { shop: session.shop },
        include: {
          files: {
            select: { id: true },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.file.findMany({
        where: { shop: session.shop, folderId: null },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return { folders, files };
  } catch (error) {
    console.error("Error loading files:", error);
    return { folders: [], files: [], error: error.message };
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureUploadDir();

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create-folder") {
    const name = formData.get("name")?.toString().trim();
    if (!name) {
      return { error: "Folder name is required" };
    }

    if (!prisma.folder) {
      console.error(
        "Prisma Client not regenerated. Please restart the dev server.",
      );
      return {
        error: "Database model not available. Please restart the dev server.",
      };
    }

    const folder = await prisma.folder.create({
      data: {
        name,
        shop: session.shop,
      },
    });

    return { success: true, folder };
  }

  if (intent === "delete-folder") {
    const folderId = formData.get("folderId");
    if (!folderId) {
      return { error: "No folder ID provided" };
    }

    const folder = await prisma.folder.findFirst({
      where: { id: folderId, shop: session.shop },
      include: { files: true },
    });

    if (!folder) {
      return { error: "Folder not found" };
    }

    for (const file of folder.files) {
      try {
        await deleteFile(file.path);
      } catch (error) {
        console.error("Error deleting file:", error);
      }
    }

    await prisma.folder.delete({
      where: { id: folderId },
    });

    return { success: true };
  }

  if (intent === "upload") {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return { error: "No file provided" };
    }

    const folderId = formData.get("folderId")?.toString() || null;

    const buffer = Buffer.from(await file.arrayBuffer());
    const { filename, filePath } = await saveFile(file, buffer);

    const fileRecord = await prisma.file.create({
      data: {
        filename,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        path: filePath,
        shop: session.shop,
        folderId: folderId || null,
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
      await deleteFile(fileRecord.path);
    } catch (error) {
      console.error("Error deleting file:", error);
    }

    await prisma.file.delete({
      where: { id: fileId },
    });

    return { success: true };
  }

  if (intent === "move-file") {
    const fileId = formData.get("fileId");
    const folderId = formData.get("folderId")?.toString() || null;

    if (!fileId) {
      return { error: "No file ID provided" };
    }

    const fileRecord = await prisma.file.findFirst({
      where: { id: fileId, shop: session.shop },
    });

    if (!fileRecord) {
      return { error: "File not found" };
    }

    await prisma.file.update({
      where: { id: fileId },
      data: { folderId },
    });

    return { success: true };
  }

  return { error: "Invalid intent" };
};

export default function Files() {
  const { folders, files } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [uploading, setUploading] = useState(false);
  const [viewMode, setViewMode] = useState("grid");
  const [showFolderModal, setShowFolderModal] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [folderFiles, setFolderFiles] = useState([]);

  useEffect(() => {
    if (fetcher.data?.success) {
      if (fetcher.data?.folder) {
        shopify.toast.show("Folder created successfully");
        setShowFolderModal(false);
        setFolderName("");
        revalidator.revalidate();
      } else if (fetcher.data?.file) {
        shopify.toast.show("File uploaded successfully");
        setUploading(false);
        revalidator.revalidate();
      } else if (fetcher.formData?.get("intent") === "delete") {
        shopify.toast.show("File deleted successfully");
        revalidator.revalidate();
      } else if (fetcher.formData?.get("intent") === "delete-folder") {
        shopify.toast.show("Folder deleted successfully");
        if (selectedFolder?.id === fetcher.formData.get("folderId")) {
          setSelectedFolder(null);
          setFolderFiles([]);
        }
        revalidator.revalidate();
      } else if (fetcher.formData?.get("intent") === "move-file") {
        shopify.toast.show("File moved successfully");
        revalidator.revalidate();
      }
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setUploading(false);
    }
  }, [fetcher.data, shopify, selectedFolder, revalidator]);

  useEffect(() => {
    if (selectedFolder) {
      const loadFolderFiles = async () => {
        try {
          const response = await fetch(`/files/folder/${selectedFolder.id}`);
          if (response.ok) {
            const data = await response.json();
            setFolderFiles(data.files || []);
          }
        } catch (error) {
          console.error("Error loading folder files:", error);
          setFolderFiles([]);
        }
      };
      loadFolderFiles();
    } else {
      setFolderFiles([]);
    }
  }, [selectedFolder, folders]);

  const handleFileUpload = async (event, folderId = null) => {
    const fileInput = event.target;
    const file = fileInput.files?.[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("intent", "upload");
    if (folderId) {
      formData.append("folderId", folderId);
    }

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

  const handleDeleteFolder = (folderId) => {
    if (
      !confirm("Are you sure you want to delete this folder and all its files?")
    )
      return;

    const formData = new FormData();
    formData.append("intent", "delete-folder");
    formData.append("folderId", folderId);

    fetcher.submit(formData, { method: "POST" });
  };

  const handleCreateFolder = () => {
    if (!folderName.trim()) {
      shopify.toast.show("Folder name is required", { isError: true });
      return;
    }

    const formData = new FormData();
    formData.append("intent", "create-folder");
    formData.append("name", folderName.trim());

    fetcher.submit(formData, { method: "POST" });
  };

  const handleDownload = (file) => {
    window.location.href = `/files/${file.id}/download`;
  };

  const handleMoveFile = (fileId) => {
    const folderOptions = folders.map((f) => `${f.id}:${f.name}`).join(",");
    const choice = prompt(
      `Move file to folder:\n${folders.map((f, i) => `${i + 1}. ${f.name}`).join("\n")}\n0. Root (no folder)\n\nEnter folder number or name:`,
    );
    if (choice === null) return;

    let folderId = null;
    const choiceNum = parseInt(choice);
    if (!isNaN(choiceNum)) {
      if (choiceNum === 0) {
        folderId = null;
      } else if (choiceNum > 0 && choiceNum <= folders.length) {
        folderId = folders[choiceNum - 1].id;
      } else {
        shopify.toast.show("Invalid folder number", { isError: true });
        return;
      }
    } else {
      const foundFolder = folders.find(
        (f) => f.name.toLowerCase() === choice.toLowerCase(),
      );
      if (foundFolder) {
        folderId = foundFolder.id;
      } else {
        shopify.toast.show("Folder not found", { isError: true });
        return;
      }
    }

    const formData = new FormData();
    formData.append("intent", "move-file");
    formData.append("fileId", fileId);
    if (folderId) {
      formData.append("folderId", folderId);
    }

    fetcher.submit(formData, { method: "POST" });
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getFileIcon = (mimeType) => {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType.startsWith("video/")) return "🎥";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("zip") || mimeType.includes("archive")) return "📦";
    return "📎";
  };

  const displayItems = selectedFolder ? folderFiles : files;
  const displayFolders = selectedFolder ? [] : folders;

  return (
    <s-page
      heading={
        selectedFolder ? `Folder: ${selectedFolder.name}` : "File Manager"
      }
    >
      <s-stack direction="inline" gap="base" slot="primary-action">
        {selectedFolder && (
          <s-button
            variant="secondary"
            onClick={() => {
              setSelectedFolder(null);
              setFolderFiles([]);
            }}
          >
            ← Back
          </s-button>
        )}
        <s-button
          variant="secondary"
          onClick={() => setShowFolderModal(true)}
          disabled={uploading}
        >
          New Folder
        </s-button>
        <s-button
          variant="primary"
          onClick={() => document.getElementById("file-upload")?.click()}
          disabled={uploading}
          loading={uploading}
        >
          Upload File
        </s-button>
        <s-stack direction="inline" gap="tight">
          <s-button
            variant={viewMode === "grid" ? "primary" : "tertiary"}
            onClick={() => setViewMode("grid")}
            size="small"
          >
            Grid
          </s-button>
          <s-button
            variant={viewMode === "list" ? "primary" : "tertiary"}
            onClick={() => setViewMode("list")}
            size="small"
          >
            List
          </s-button>
        </s-stack>
      </s-stack>

      <input
        id="file-upload"
        type="file"
        style={{ display: "none" }}
        onChange={(e) => handleFileUpload(e, selectedFolder?.id)}
        disabled={uploading}
      />

      {showFolderModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.5)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => {
            setShowFolderModal(false);
            setFolderName("");
          }}
        >
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="base"
            style={{
              zIndex: 10001,
              minWidth: "400px",
              maxWidth: "90vw",
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <s-stack direction="block" gap="base">
              <s-heading size="medium">Create New Folder</s-heading>
              <s-text-field
                label="Folder Name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleCreateFolder();
                  } else if (e.key === "Escape") {
                    setShowFolderModal(false);
                    setFolderName("");
                  }
                }}
                autoFocus
              />
              <s-stack direction="inline" gap="base" align="end">
                <s-button
                  variant="secondary"
                  onClick={() => {
                    setShowFolderModal(false);
                    setFolderName("");
                  }}
                >
                  Cancel
                </s-button>
                <s-button
                  variant="primary"
                  onClick={handleCreateFolder}
                  disabled={!folderName.trim() || fetcher.state !== "idle"}
                  loading={fetcher.state !== "idle"}
                >
                  Create
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        </div>
      )}

      <s-section
        heading={selectedFolder ? "Files in Folder" : "Folders & Files"}
      >
        {displayFolders.length === 0 && displayItems.length === 0 ? (
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base" align="center">
              <s-text
                size="large"
                style={{ fontSize: "48px", marginBottom: "1rem" }}
              >
                {selectedFolder ? "📂" : "📁"}
              </s-text>
              <s-heading size="medium">
                {selectedFolder
                  ? "This folder is empty"
                  : "No files or folders yet"}
              </s-heading>
              <s-text tone="subdued" size="medium">
                {selectedFolder
                  ? "Upload files to this folder to get started."
                  : "Create a folder or upload a file to get started."}
              </s-text>
              {!selectedFolder && (
                <s-stack
                  direction="inline"
                  gap="base"
                  style={{ marginTop: "1rem" }}
                >
                  <s-button
                    variant="secondary"
                    onClick={() => setShowFolderModal(true)}
                  >
                    Create Folder
                  </s-button>
                  <s-button
                    variant="primary"
                    onClick={() =>
                      document.getElementById("file-upload")?.click()
                    }
                  >
                    Upload File
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {displayFolders.length > 0 && (
              <s-stack
                direction={viewMode === "grid" ? "block" : "block"}
                gap="base"
              >
                <s-heading size="small">Folders</s-heading>
                {viewMode === "grid" ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: "1rem",
                    }}
                  >
                    {displayFolders.map((folder) => (
                      <s-box
                        key={folder.id}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="subdued"
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelectedFolder(folder)}
                      >
                        <s-stack direction="block" gap="tight" align="center">
                          <s-text size="large">📁</s-text>
                          <s-heading size="small">{folder.name}</s-heading>
                          <s-text tone="subdued" size="small">
                            {folder.files.length} file
                            {folder.files.length !== 1 ? "s" : ""}
                          </s-text>
                        </s-stack>
                      </s-box>
                    ))}
                  </div>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {displayFolders.map((folder) => (
                      <s-box
                        key={folder.id}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="subdued"
                        style={{ cursor: "pointer" }}
                        onClick={() => setSelectedFolder(folder)}
                      >
                        <s-stack
                          direction="inline"
                          gap="base"
                          align="space-between"
                        >
                          <s-stack direction="inline" gap="base" align="center">
                            <s-text size="large">📁</s-text>
                            <s-stack direction="block" gap="tight">
                              <s-heading size="small">{folder.name}</s-heading>
                              <s-text tone="subdued" size="small">
                                {folder.files.length} file
                                {folder.files.length !== 1 ? "s" : ""}
                              </s-text>
                            </s-stack>
                          </s-stack>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteFolder(folder.id);
                            }}
                            disabled={fetcher.state !== "idle"}
                          >
                            Delete
                          </s-button>
                        </s-stack>
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            )}

            {displayItems.length > 0 && (
              <s-stack direction="block" gap="base">
                <s-heading size="small">
                  {selectedFolder ? "Files" : "Files (No Folder)"}
                </s-heading>
                {viewMode === "grid" ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: "1rem",
                    }}
                  >
                    {displayItems.map((file) => (
                      <s-box
                        key={file.id}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="subdued"
                      >
                        <s-stack direction="block" gap="tight" align="center">
                          <s-text size="large">
                            {getFileIcon(file.mimeType)}
                          </s-text>
                          <s-heading
                            size="small"
                            style={{ textAlign: "center" }}
                          >
                            {file.originalName}
                          </s-heading>
                          <s-text tone="subdued" size="small">
                            {formatFileSize(file.size)}
                          </s-text>
                          <s-stack direction="inline" gap="tight">
                            <s-button
                              variant="secondary"
                              size="small"
                              onClick={() => handleDownload(file)}
                            >
                              Download
                            </s-button>
                            {!selectedFolder && folders.length > 0 && (
                              <s-button
                                variant="tertiary"
                                size="small"
                                onClick={() => handleMoveFile(file.id)}
                              >
                                Move
                              </s-button>
                            )}
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              size="small"
                              onClick={() => handleDelete(file.id)}
                              disabled={fetcher.state !== "idle"}
                            >
                              Delete
                            </s-button>
                          </s-stack>
                        </s-stack>
                      </s-box>
                    ))}
                  </div>
                ) : (
                  <s-stack direction="block" gap="tight">
                    {displayItems.map((file) => (
                      <s-box
                        key={file.id}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="subdued"
                      >
                        <s-stack
                          direction="inline"
                          gap="base"
                          align="space-between"
                        >
                          <s-stack direction="inline" gap="base" align="center">
                            <s-text size="large">
                              {getFileIcon(file.mimeType)}
                            </s-text>
                            <s-stack direction="block" gap="tight">
                              <s-heading size="small">
                                {file.originalName}
                              </s-heading>
                              <s-text tone="subdued" size="small">
                                {formatFileSize(file.size)} • {file.mimeType} •{" "}
                                {formatDate(file.createdAt)}
                              </s-text>
                            </s-stack>
                          </s-stack>
                          <s-stack direction="inline" gap="tight">
                            <s-button
                              variant="secondary"
                              onClick={() => handleDownload(file)}
                            >
                              Download
                            </s-button>
                            {!selectedFolder && folders.length > 0 && (
                              <s-button
                                variant="tertiary"
                                onClick={() => handleMoveFile(file.id)}
                              >
                                Move
                              </s-button>
                            )}
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
                      </s-box>
                    ))}
                  </s-stack>
                )}
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="File Manager">
        <s-paragraph>
          <s-text>
            Organize your digital files with folders. Create folders to group
            related files together for better organization.
          </s-text>
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Create folders to organize files</s-list-item>
          <s-list-item>Upload files to folders or root</s-list-item>
          <s-list-item>Switch between grid and list views</s-list-item>
          <s-list-item>Move files between folders</s-list-item>
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
