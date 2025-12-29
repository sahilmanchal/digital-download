import { useState, useEffect, useMemo, useCallback } from "react";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureUploadDir, saveFile, deleteFile } from "../files.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureUploadDir();

  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");

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
        where: {
          shop: session.shop,
          folderId: folderId === "root" ? null : folderId || null,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return { folders, files, currentFolderId: folderId };
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

  if (intent === "bulk-delete") {
    const itemIds = formData.get("itemIds");
    if (!itemIds) {
      return { error: "No items provided" };
    }

    const ids = JSON.parse(itemIds);
    const fileIds = ids.filter((id) => id.startsWith("file-"));
    const folderIds = ids.filter((id) => id.startsWith("folder-"));

    for (const id of fileIds) {
      const fileId = id.replace("file-", "");
      const fileRecord = await prisma.file.findFirst({
        where: { id: fileId, shop: session.shop },
      });

      if (fileRecord) {
        try {
          await deleteFile(fileRecord.path);
          await prisma.file.delete({ where: { id: fileId } });
        } catch (error) {
          console.error("Error deleting file:", error);
        }
      }
    }

    for (const id of folderIds) {
      const folderId = id.replace("folder-", "");
      const folder = await prisma.folder.findFirst({
        where: { id: folderId, shop: session.shop },
        include: { files: true },
      });

      if (folder) {
        for (const file of folder.files) {
          try {
            await deleteFile(file.path);
          } catch (error) {
            console.error("Error deleting file:", error);
          }
        }
        await prisma.folder.delete({ where: { id: folderId } });
      }
    }

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

  if (intent === "bulk-move") {
    const fileIds = formData.get("fileIds");
    const folderId = formData.get("folderId")?.toString() || null;

    if (!fileIds) {
      return { error: "No files provided" };
    }

    const ids = JSON.parse(fileIds);

    for (const id of ids) {
      const fileId = id.replace("file-", "");
      await prisma.file.update({
        where: { id: fileId },
        data: { folderId },
      });
    }

    return { success: true };
  }

  return { error: "Invalid intent" };
};

export default function Files() {
  const { folders, files } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  // State management
  const [searchParams, setSearchParams] = useSearchParams();
  const currentFolderId = searchParams.get("folderId");

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState("");
  const [viewMode, setViewMode] = useState("list");
  const [folderName, setFolderName] = useState("");

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === currentFolderId),
    [folders, currentFolderId],
  );
  const [selectedItems, setSelectedItems] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [lastProcessedAction, setLastProcessedAction] = useState(null);
  const [filterType, setFilterType] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [sortOrder, setSortOrder] = useState("asc");
  const [isDragging, setIsDragging] = useState(false);
  const [itemsToMove, setItemsToMove] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);

  // Build breadcrumbs
  const breadcrumbs = useMemo(() => {
    const crumbs = [{ id: "root", name: "All Files" }];
    // If we support nested folders in the future, we would recursively find parents here.
    // For now, it's just Root -> Current Folder.
    if (selectedFolder) {
      crumbs.push({ id: selectedFolder.id, name: selectedFolder.name });
    }
    return crumbs;
  }, [selectedFolder]);

  // Handle fetcher responses
  useEffect(() => {
    if (!fetcher.data) return;

    const intent = fetcher.formData?.get("intent");
    const fileId = fetcher.data?.file?.id || fetcher.data?.folder?.id || "";
    const actionKey = `${intent}-${fileId}-${fetcher.data?.success ? "success" : "error"}`;

    // Prevent duplicate notifications
    if (lastProcessedAction === actionKey) return;

    if (fetcher.data?.success) {
      if (fetcher.data?.folder) {
        shopify.toast.show("Folder created successfully", { duration: 3000 });
        setFolderName("");
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      } else if (fetcher.data?.file) {
        shopify.toast.show("File uploaded successfully", { duration: 3000 });
        setUploading(false);
        setUploadProgress(0);
        setUploadFileName("");
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      } else if (intent === "delete") {
        shopify.toast.show("File deleted successfully", { duration: 3000 });
        setSelectedItems(new Set());
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      } else if (intent === "bulk-delete") {
        shopify.toast.show("Items deleted successfully", { duration: 3000 });
        setSelectedItems(new Set());
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      } else if (intent === "delete-folder") {
        shopify.toast.show("Folder deleted successfully", { duration: 3000 });
        if (currentFolderId === fetcher.formData.get("folderId")) {
          setSearchParams({});
        }
        setSelectedItems(new Set());
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      } else if (intent === "move-file" || intent === "bulk-move") {
        shopify.toast.show("Files moved successfully", { duration: 3000 });
        const modal = document.getElementById("move-modal");
        if (modal && typeof modal.hide === "function") {
          modal.hide();
        }
        setItemsToMove([]);
        setSelectedItems(new Set());
        setLastProcessedAction(actionKey);
        setTimeout(() => revalidator.revalidate(), 100);
      }
    }
    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true, duration: 3000 });
      setUploading(false);
      setUploadProgress(0);
      setUploadFileName("");
      setLastProcessedAction(actionKey);
    }
  }, [
    fetcher.data,
    shopify,
    selectedFolder,
    revalidator,
    lastProcessedAction,
    setSearchParams,
  ]);

  // Re-fetch files when folder moves
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  // Drag and drop handlers
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target === e.currentTarget) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length === 0) return;

      setUploading(true);

      for (const file of droppedFiles) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("intent", "upload");
        if (selectedFolder) {
          formData.append("folderId", selectedFolder.id);
        }

        fetcher.submit(formData, {
          method: "POST",
          encType: "multipart/form-data",
        });
      }
    },
    [selectedFolder, fetcher],
  );

  // File upload handler
  const handleFileUpload = async (event, folderId = null) => {
    const fileInput = event.target;
    const uploadedFiles = Array.from(fileInput.files || []);
    if (uploadedFiles.length === 0) return;

    setUploading(true);

    for (const file of uploadedFiles) {
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
    }

    fileInput.value = "";
  };

  // Delete handlers
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

  const handleBulkDelete = () => {
    if (selectedItems.size === 0) return;
    if (
      !confirm(`Are you sure you want to delete ${selectedItems.size} item(s)?`)
    )
      return;

    const formData = new FormData();
    formData.append("intent", "bulk-delete");
    formData.append("itemIds", JSON.stringify(Array.from(selectedItems)));

    fetcher.submit(formData, { method: "POST" });
  };

  // Folder creation
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

  // Download handler
  const handleDownload = (file) => {
    window.location.href = `/files/${file.id}/download`;
  };

  // Move handlers
  const handleMoveFile = (fileId) => {
    setItemsToMove([`file-${fileId}`]);
  };

  const handleBulkMove = () => {
    const fileItems = Array.from(selectedItems).filter((id) =>
      id.startsWith("file-"),
    );
    if (fileItems.length === 0) {
      shopify.toast.show("Please select files to move", { isError: true });
      return;
    }
    setItemsToMove(fileItems);
  };

  const handleMoveToFolder = (targetFolderId) => {
    if (itemsToMove.length === 1) {
      const fileId = itemsToMove[0].replace("file-", "");
      const formData = new FormData();
      formData.append("intent", "move-file");
      formData.append("fileId", fileId);
      if (targetFolderId) {
        formData.append("folderId", targetFolderId);
      }
      fetcher.submit(formData, { method: "POST" });
    } else {
      const formData = new FormData();
      formData.append("intent", "bulk-move");
      formData.append("fileIds", JSON.stringify(itemsToMove));
      if (targetFolderId) {
        formData.append("folderId", targetFolderId);
      }
      fetcher.submit(formData, { method: "POST" });
    }
  };

  // Selection handlers
  const toggleSelection = (itemId) => {
    const newSelection = new Set(selectedItems);
    if (newSelection.has(itemId)) {
      newSelection.delete(itemId);
    } else {
      newSelection.add(itemId);
    }
    setSelectedItems(newSelection);
  };

  const selectAll = () => {
    const allItems = new Set();
    displayFolders.forEach((folder) => allItems.add(`folder-${folder.id}`));
    displayItems.forEach((file) => allItems.add(`file-${file.id}`));
    setSelectedItems(allItems);
  };

  const clearSelection = () => {
    setSelectedItems(new Set());
  };

  // Utility functions
  const formatFileSize = (bytes) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getFileIcon = (mimeType) => {
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType.startsWith("video/")) return "🎥";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.includes("pdf")) return "📄";
    if (mimeType.includes("zip") || mimeType.includes("archive")) return "📦";
    if (mimeType.includes("word") || mimeType.includes("document")) return "📝";
    if (mimeType.includes("sheet") || mimeType.includes("excel")) return "📊";
    if (mimeType.includes("presentation") || mimeType.includes("powerpoint"))
      return "📽️";
    if (mimeType.includes("html")) return "🌐";
    return "📎";
  };

  const getFileTypeCategory = (mimeType) => {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.includes("pdf")) return "document";
    if (
      mimeType.includes("word") ||
      mimeType.includes("document") ||
      mimeType.includes("text")
    )
      return "document";
    if (mimeType.includes("sheet") || mimeType.includes("excel"))
      return "spreadsheet";
    if (mimeType.includes("zip") || mimeType.includes("archive"))
      return "archive";
    return "other";
  };

  const getFileTypeName = (mimeType) => {
    if (mimeType.startsWith("image/")) return "Image";
    if (mimeType.startsWith("video/")) return "Video";
    if (mimeType.includes("pdf")) return "PDF";
    if (mimeType.includes("zip")) return "ZIP";
    if (mimeType.includes("word")) return "DOC";
    if (mimeType.includes("sheet")) return "XLS";
    if (mimeType.includes("html")) return "HTML";
    if (mimeType.includes("text")) return "TXT";
    return "FILE";
  };

  // Truncate filename in the middle
  const truncateFilename = (filename, maxLength = 20) => {
    if (filename.length <= maxLength) return filename;

    const extension = filename.split(".").pop();
    const nameWithoutExt = filename.substring(0, filename.lastIndexOf("."));

    if (nameWithoutExt.length <= maxLength - extension.length - 4) {
      return filename;
    }

    const charsToShow = Math.floor((maxLength - extension.length - 3) / 2);
    const start = nameWithoutExt.substring(0, charsToShow);
    const end = nameWithoutExt.substring(nameWithoutExt.length - charsToShow);

    return `${start}...${end}.${extension}`;
  };

  // Filter and sort items
  const displayItems = useMemo(() => {
    let items = files;

    if (searchQuery) {
      items = items.filter((file) =>
        file.originalName.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    }

    if (filterType !== "all") {
      items = items.filter(
        (file) => getFileTypeCategory(file.mimeType) === filterType,
      );
    }

    items = [...items].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case "name":
          comparison = a.originalName.localeCompare(b.originalName);
          break;
        case "date":
          comparison =
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case "size":
          comparison = a.size - b.size;
          break;
        case "type":
          comparison = a.mimeType.localeCompare(b.mimeType);
          break;
        default:
          comparison = 0;
      }

      return sortOrder === "asc" ? comparison : -comparison;
    });

    return items;
  }, [selectedFolder, files, searchQuery, filterType, sortBy, sortOrder]);

  const displayFolders = useMemo(() => {
    if (selectedFolder) return [];

    let folderList = [...folders];

    if (searchQuery) {
      folderList = folderList.filter((folder) =>
        folder.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    }

    folderList.sort((a, b) => {
      const comparison = a.name.localeCompare(b.name);
      return sortOrder === "asc" ? comparison : -comparison;
    });

    return folderList;
  }, [selectedFolder, folders, searchQuery, sortOrder]);

  // Combine folders and files for table view
  const allItems = useMemo(() => {
    const items = [];

    // Add folders first
    displayFolders.forEach((folder) => {
      items.push({
        id: `folder-${folder.id}`,
        type: "folder",
        name: folder.name,
        fileType: "Folder",
        size: `${folder.files.length} items`,
        date: formatDate(folder.createdAt),
        data: folder,
      });
    });

    // Add files
    displayItems.forEach((file) => {
      items.push({
        id: `file-${file.id}`,
        type: "file",
        name: file.originalName,
        fileType: getFileTypeName(file.mimeType),
        size: formatFileSize(file.size),
        date: formatDate(file.createdAt),
        data: file,
      });
    });

    return items;
  }, [displayFolders, displayItems]);

  // Keyboard shortcuts and click outside handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Delete" && selectedItems.size > 0) {
        handleBulkDelete();
      }
      if (e.ctrlKey && e.key === "a") {
        e.preventDefault();
        selectAll();
      }
      if (e.key === "Escape") {
        clearSelection();
        setShowSortMenu(false);
      }
    };

    const handleClickOutside = (e) => {
      if (showSortMenu && !e.target.closest("[data-sort-menu]")) {
        setShowSortMenu(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("click", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("click", handleClickOutside);
    };
  }, [selectedItems, showSortMenu]);

  const totalFiles =
    files.length + folders.reduce((acc, f) => acc + f.files.length, 0);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: "relative" }}
    >
      <s-page heading={selectedFolder ? selectedFolder.name : "File Manager"}>
        <s-button slot="secondary-actions" commandFor="modal">
          New Folder
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => document.getElementById("file-upload")?.click()}
          disabled={uploading}
          loading={uploading}
        >
          Upload Files
        </s-button>

        <input
          id="file-upload"
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleFileUpload(e, currentFolderId)}
          disabled={uploading}
        />

        {/* Unified Search, Filter, and Sort Controls */}
        <s-section>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base">
              {/* Top Control Row */}
              <s-stack direction="inline" gap="tight" align="center">
                <s-button
                  variant={showSearch ? "primary" : "secondary"}
                  onClick={() => {
                    setShowSearch(!showSearch);
                    if (!showSearch) {
                      setShowFilter(false);
                      setShowSortMenu(false);
                    }
                  }}
                  size="small"
                >
                  🔍
                </s-button>

                <s-button
                  variant={showFilter ? "primary" : "secondary"}
                  onClick={() => {
                    setShowFilter(!showFilter);
                    if (!showFilter) {
                      setShowSearch(false);
                      setShowSortMenu(false);
                    }
                  }}
                  size="small"
                >
                  Filter
                </s-button>

                <div style={{ position: "relative" }} data-sort-menu>
                  <s-button
                    variant={showSortMenu ? "primary" : "secondary"}
                    onClick={() => {
                      setShowSortMenu(!showSortMenu);
                      if (!showSortMenu) {
                        setShowSearch(false);
                        setShowFilter(false);
                      }
                    }}
                    size="small"
                  >
                    ⇅ Sort
                  </s-button>

                  {showSortMenu && (
                    <div
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        backgroundColor: "white",
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        minWidth: "220px",
                        zIndex: 1000,
                        padding: "8px",
                      }}
                    >
                      <div
                        style={{
                          padding: "8px 12px",
                          fontWeight: "600",
                          fontSize: "13px",
                        }}
                      >
                        Sort by
                      </div>
                      {["name", "date", "size", "type"].map((sortType) => (
                        <div
                          key={sortType}
                          onClick={() => {
                            setSortBy(sortType);
                          }}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            borderRadius: "4px",
                            backgroundColor:
                              sortBy === sortType
                                ? "rgba(0, 128, 96, 0.1)"
                                : "transparent",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                          onMouseEnter={(e) => {
                            if (sortBy !== sortType) {
                              e.currentTarget.style.backgroundColor = "#f6f6f7";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (sortBy !== sortType) {
                              e.currentTarget.style.backgroundColor =
                                "transparent";
                            }
                          }}
                        >
                          <div
                            style={{
                              width: "16px",
                              height: "16px",
                              borderRadius: "50%",
                              border: "2px solid #c9cccf",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor:
                                sortBy === sortType ? "#008060" : "white",
                              borderColor:
                                sortBy === sortType ? "#008060" : "#c9cccf",
                            }}
                          >
                            {sortBy === sortType && (
                              <div
                                style={{
                                  width: "6px",
                                  height: "6px",
                                  borderRadius: "50%",
                                  backgroundColor: "white",
                                }}
                              />
                            )}
                          </div>
                          <span style={{ fontSize: "14px" }}>
                            {sortType === "name"
                              ? "File name"
                              : sortType === "date"
                                ? "Created"
                                : sortType === "size"
                                  ? "Size"
                                  : "Type"}
                          </span>
                        </div>
                      ))}

                      <div
                        style={{
                          borderTop: "1px solid #e1e3e5",
                          marginTop: "8px",
                          paddingTop: "8px",
                        }}
                      >
                        <div
                          onClick={() => setSortOrder("asc")}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            borderRadius: "4px",
                            backgroundColor:
                              sortOrder === "asc"
                                ? "rgba(0, 128, 96, 0.1)"
                                : "transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (sortOrder !== "asc") {
                              e.currentTarget.style.backgroundColor = "#f6f6f7";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (sortOrder !== "asc") {
                              e.currentTarget.style.backgroundColor =
                                "transparent";
                            }
                          }}
                        >
                          ↑ Lowest to highest
                        </div>
                        <div
                          onClick={() => setSortOrder("desc")}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            borderRadius: "4px",
                            backgroundColor:
                              sortOrder === "desc"
                                ? "rgba(0, 128, 96, 0.1)"
                                : "transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (sortOrder !== "desc") {
                              e.currentTarget.style.backgroundColor = "#f6f6f7";
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (sortOrder !== "desc") {
                              e.currentTarget.style.backgroundColor =
                                "transparent";
                            }
                          }}
                        >
                          ↓ Highest to lowest
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </s-stack>

              {/* Expandable Search Bar */}
              {showSearch && (
                <s-text-field
                  placeholder="Search files and folders..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ width: "100%" }}
                  autoFocus
                />
              )}

              {/* Expandable Filter Options */}
              {showFilter && (
                <s-stack direction="inline" gap="tight" align="center">
                  <s-text size="small" fontWeight="medium">
                    Type:
                  </s-text>
                  <s-select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    style={{ minWidth: "150px" }}
                  >
                    <option value="all">All Types</option>
                    <option value="image">Images</option>
                    <option value="video">Videos</option>
                    <option value="audio">Audio</option>
                    <option value="document">Documents</option>
                    <option value="archive">Archives</option>
                  </s-select>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-section>

        {/* Bulk Actions Bar */}
        {selectedItems.size > 0 && (
          <s-section>
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="inline" gap="base" align="space-between">
                <s-stack direction="inline" gap="base" align="center">
                  <s-text fontWeight="bold">
                    {selectedItems.size} selected
                  </s-text>
                  <s-button
                    variant="secondary"
                    onClick={() =>
                      shopify.toast.show("Coming soon: Attach to Products")
                    }
                    size="small"
                  >
                    Attach to Products
                  </s-button>
                </s-stack>
                <s-stack direction="inline" gap="tight">
                  <s-button
                    variant="secondary"
                    onClick={handleBulkMove}
                    commandFor="move-modal"
                    size="small"
                  >
                    Move
                  </s-button>
                  <s-button
                    variant="primary"
                    tone="critical"
                    onClick={handleBulkDelete}
                    size="small"
                  >
                    Delete
                  </s-button>
                  <s-button
                    variant="tertiary"
                    onClick={clearSelection}
                    size="small"
                  >
                    Clear
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          </s-section>
        )}

        {/* Breadcrumbs and View Mode */}
        <s-section>
          <s-stack direction="inline" gap="base" align="space-between">
            <div style={{ padding: "0 4px", flex: 1 }}>
              {breadcrumbs.length > 1 ? (
                <s-stack gap="small" direction="inline" align="center">
                  {breadcrumbs.map((segment, index) => {
                    const isLast = index === breadcrumbs.length - 1;

                    return (
                      <span
                        key={segment.id || "root"}
                        style={{ display: "inline-flex", alignItems: "center" }}
                      >
                        {index > 0 && (
                          <s-text style={{ margin: "0 8px", color: "#6d7175" }}>
                            &gt;
                          </s-text>
                        )}

                        {isLast ? (
                          <s-text fontWeight="bold">{segment.name}</s-text>
                        ) : (
                          <s-link
                            href="#"
                            onClick={(event) => {
                              event.preventDefault();
                              if (segment.id === "root") {
                                setSearchParams({});
                              } else {
                                setSearchParams({ folderId: segment.id });
                              }
                              clearSelection();
                            }}
                          >
                            {segment.name}
                          </s-link>
                        )}
                      </span>
                    );
                  })}
                </s-stack>
              ) : (
                <s-text fontWeight="bold">All Files</s-text>
              )}
            </div>

            <s-stack direction="inline" gap="tight">
              <s-button
                variant={viewMode === "grid" ? "primary" : "secondary"}
                onClick={() => setViewMode("grid")}
                size="small"
              >
                Grid
              </s-button>
              <s-button
                variant={viewMode === "list" ? "primary" : "secondary"}
                onClick={() => setViewMode("list")}
                size="small"
              >
                List
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>

        {/* Main Content Listing */}
        <s-section>
          {allItems.length === 0 ? (
            // Empty State
            <s-box
              padding="extra-large"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="base" align="center">
                <s-text style={{ fontSize: "64px" }}>📁</s-text>
                <s-heading size="large">
                  {searchQuery ? "No results found" : "No files or folders yet"}
                </s-heading>
                <s-text tone="subdued" style={{ textAlign: "center" }}>
                  {searchQuery
                    ? "Try adjusting your search"
                    : "Create folders or upload files to get started"}
                </s-text>
                {!searchQuery && (
                  <s-stack direction="inline" gap="base">
                    <s-button variant="secondary" commandFor="modal">
                      Create Folder
                    </s-button>
                    <s-button
                      variant="primary"
                      onClick={() =>
                        document.getElementById("file-upload")?.click()
                      }
                    >
                      Upload Files
                    </s-button>
                  </s-stack>
                )}
              </s-stack>
            </s-box>
          ) : viewMode === "list" ? (
            // List/Table View
            <div style={{ width: "100%", overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid #e1e3e5",
                      backgroundColor: "#f6f6f7",
                    }}
                  >
                    <th
                      style={{
                        width: "40px",
                        padding: "12px",
                        textAlign: "left",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={
                          selectedItems.size === allItems.length &&
                          allItems.length > 0
                        }
                        onChange={() => {
                          if (selectedItems.size === allItems.length) {
                            clearSelection();
                          } else {
                            selectAll();
                          }
                        }}
                      />
                    </th>
                    <th style={{ textAlign: "left", padding: "12px" }}>File</th>
                    <th style={{ textAlign: "left", padding: "12px" }}>Type</th>
                    <th style={{ textAlign: "left", padding: "12px" }}>Size</th>
                    <th style={{ textAlign: "left", padding: "12px" }}>
                      Usage
                    </th>
                    <th style={{ textAlign: "left", padding: "12px" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {allItems.map((item) => (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: "1px solid #e1e3e5",
                        cursor: item.type === "folder" ? "pointer" : "default",
                      }}
                      onClick={() => {
                        if (item.type === "folder") {
                          setSearchParams({ folderId: item.data.id });
                          clearSelection();
                        }
                      }}
                    >
                      <td
                        style={{ padding: "12px" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedItems.has(item.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleSelection(item.id);
                          }}
                        />
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-stack direction="inline" gap="base" align="center">
                          <s-text style={{ fontSize: "20px" }}>
                            {item.type === "folder"
                              ? "📁"
                              : getFileIcon(item.data.mimeType)}
                          </s-text>
                          <s-text
                            style={{
                              fontWeight:
                                item.type === "folder" ? "500" : "400",
                            }}
                          >
                            {item.name}
                          </s-text>
                        </s-stack>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text tone="subdued" size="small">
                          {item.fileType.toLowerCase()}
                        </s-text>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text tone="subdued" size="small">
                          {item.size}
                        </s-text>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <s-text tone="subdued" size="small">
                          Not used yet
                        </s-text>
                      </td>
                      <td
                        style={{ padding: "12px" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <s-link
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (item.type === "file") {
                              handleDownload(item.data);
                            } else {
                              handleDeleteFolder(item.data.id);
                            }
                          }}
                          style={{
                            textDecoration: "none",
                            color: "#0066cc",
                          }}
                        >
                          Edit
                        </s-link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            // Grid View
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: "2rem 1.5rem",
                padding: "1rem",
              }}
            >
              {/* Folders */}
              {displayFolders.map((folder) => (
                <div
                  key={folder.id}
                  style={{
                    position: "relative",
                    textAlign: "center",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedItems.has(`folder-${folder.id}`)}
                    onChange={(e) => {
                      e.stopPropagation();
                      toggleSelection(`folder-${folder.id}`);
                    }}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      cursor: "pointer",
                      zIndex: 1,
                    }}
                  />
                  <div
                    onClick={() => setSearchParams({ folderId: folder.id })}
                    style={{ cursor: "pointer" }}
                    title={folder.name}
                  >
                    <div
                      style={{
                        fontSize: "72px",
                        marginBottom: "0.25rem",
                        lineHeight: "1",
                      }}
                    >
                      📁
                    </div>
                    <s-text
                      size="small"
                      style={{
                        display: "block",
                        wordBreak: "break-word",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: "100%",
                      }}
                    >
                      {truncateFilename(folder.name, 18)}
                    </s-text>
                  </div>
                </div>
              ))}

              {/* Files */}
              {displayItems.map((file) => {
                const fileExt = getFileTypeName(file.mimeType);
                return (
                  <div
                    key={file.id}
                    style={{
                      position: "relative",
                      textAlign: "center",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedItems.has(`file-${file.id}`)}
                      onChange={() => toggleSelection(`file-${file.id}`)}
                      style={{
                        position: "absolute",
                        top: "0",
                        left: "0",
                        cursor: "pointer",
                        zIndex: 1,
                      }}
                    />
                    <div title={file.originalName}>
                      {file.mimeType.startsWith("image/") ? (
                        <div
                          style={{
                            position: "relative",
                            marginBottom: "0.5rem",
                          }}
                        >
                          <img
                            src={`/files/${file.id}/download`}
                            alt={file.originalName}
                            style={{
                              width: "72px",
                              height: "72px",
                              objectFit: "cover",
                              borderRadius: "4px",
                              border: "1px solid #e1e3e5",
                            }}
                          />
                        </div>
                      ) : (
                        <div
                          style={{
                            position: "relative",
                            marginBottom: "0.5rem",
                          }}
                        >
                          <div
                            style={{
                              fontSize: "72px",
                              lineHeight: "1",
                              filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.1))",
                            }}
                          >
                            {getFileIcon(file.mimeType)}
                          </div>
                          <div
                            style={{
                              position: "absolute",
                              bottom: "8px",
                              left: "50%",
                              transform: "translateX(-50%)",
                              backgroundColor: "white",
                              border: "1px solid #e1e3e5",
                              borderRadius: "3px",
                              padding: "2px 6px",
                              fontSize: "10px",
                              fontWeight: "600",
                              color: "#666",
                              textTransform: "uppercase",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                            }}
                          >
                            {fileExt}
                          </div>
                        </div>
                      )}
                      <s-text
                        size="small"
                        style={{
                          display: "block",
                          wordBreak: "break-word",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: "100%",
                        }}
                      >
                        {truncateFilename(file.originalName, 18)}
                      </s-text>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </s-section>
      </s-page>

      {/* Upload Progress Indicator */}
      {uploading && (
        <div
          style={{
            position: "fixed",
            bottom: "20px",
            right: "20px",
            zIndex: 10000,
            minWidth: "300px",
            maxWidth: "400px",
          }}
        >
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="base"
            style={{ boxShadow: "0 4px 12px rgba(0,0,0,0.15)" }}
          >
            <s-stack direction="block" gap="tight">
              <s-stack direction="inline" gap="base" align="space-between">
                <s-text size="small" fontWeight="medium">
                  Uploading: {uploadFileName}
                </s-text>
                <s-button
                  variant="tertiary"
                  size="small"
                  onClick={() => {
                    setUploading(false);
                    setUploadProgress(0);
                    setUploadFileName("");
                  }}
                >
                  ×
                </s-button>
              </s-stack>
              <div
                style={{
                  width: "100%",
                  height: "6px",
                  backgroundColor: "rgba(0,0,0,0.1)",
                  borderRadius: "3px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${uploadProgress}%`,
                    height: "100%",
                    backgroundColor: "#008060",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <s-text tone="subdued" size="small">
                {uploadProgress}%
              </s-text>
            </s-stack>
          </s-box>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 123, 255, 0.1)",
            border: "3px dashed #007bff",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <s-box padding="extra-large" borderRadius="base" background="base">
            <s-stack direction="block" gap="base" align="center">
              <s-text style={{ fontSize: "64px" }}>📤</s-text>
              <s-heading size="large">Drop files to upload</s-heading>
            </s-stack>
          </s-box>
        </div>
      )}

      {/* Create Folder Modal */}
      <s-modal id="modal" heading="Create New Folder">
        <s-text-field
          label="Folder Name"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleCreateFolder();
            } else if (e.key === "Escape") {
              document.getElementById("modal")?.hide();
              setFolderName("");
            }
          }}
          autoFocus
        />

        <s-button
          slot="secondary-actions"
          commandFor="modal"
          command="--hide"
          onClick={() => {
            setFolderName("");
          }}
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="modal"
          command="--hide"
          disabled={!folderName.trim()}
          onClick={handleCreateFolder}
        >
          Create Folder
        </s-button>
      </s-modal>

      {/* Move to Folder Modal */}
      <s-modal id="move-modal" heading={`Move ${itemsToMove.length} file(s)`}>
        <s-stack direction="block" gap="tight">
          <s-button
            variant="secondary"
            onClick={() => handleMoveToFolder(null)}
            style={{ width: "100%", justifyContent: "flex-start" }}
          >
            📁 Root
          </s-button>

          {folders.map((folder) => (
            <s-button
              key={folder.id}
              variant="secondary"
              onClick={() => handleMoveToFolder(folder.id)}
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              📁 {folder.name}
            </s-button>
          ))}
        </s-stack>
        <s-button
          slot="secondary-actions"
          commandFor="move-modal"
          command="--hide"
          onClick={() => {
            setItemsToMove([]);
          }}
        >
          Cancel
        </s-button>
      </s-modal>
    </div>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
