'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface FileUploadProps {
  onUploadComplete: (uploadId: string, files: string[]) => void;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const newFiles = Array.from(e.dataTransfer.files);
      setFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append('files', file);
      });

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        setUploadId(data.uploadId);
        const fileNames = data.files.map((f: any) => f.filename);
        onUploadComplete(data.uploadId, fileNames);
      } else {
        alert('Upload failed');
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const clearFiles = () => {
    setFiles([]);
    setUploadId(null);
  };

  return (
    <div className="space-y-2">
      <div 
        className={`border-2 border-dashed rounded-lg p-3 transition-colors ${
          isDragging 
            ? 'border-blue-400 bg-blue-50' 
            : 'border-gray-300 bg-gray-50'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center gap-2">
          <span style={{fontSize: '16px'}}>📎</span>
          <div className="flex-1">
            <label htmlFor="file-upload" className="cursor-pointer">
              <span className="text-sm font-medium text-blue-600 hover:text-blue-500">
                Click or drag files here
              </span>
              <input
                id="file-upload"
                name="file-upload"
                type="file"
                multiple
                accept=".txt,.md,.pdf,.docx"
                className="sr-only"
                onChange={handleFileChange}
                disabled={uploading || uploadId !== null}
              />
            </label>
            <p className="text-xs text-gray-500">
              .txt, .md, .pdf, .docx
            </p>
          </div>
        </div>
      </div>

      {files.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-gray-700">
            Selected Files ({files.length})
          </h4>
          <div className="space-y-1">
            {files.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between bg-white border border-gray-200 rounded px-2 py-1.5"
              >
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-700">{file.name}</span>
                  <span className="text-xs text-gray-500">
                    ({(file.size / 1024).toFixed(1)} KB)
                  </span>
                </div>
                {!uploadId && (
                  <button
                    onClick={() => removeFile(index)}
                    className="text-red-500 hover:text-red-700"
                    disabled={uploading}
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          {uploadId ? (
            <div className="flex items-center justify-between p-2 bg-green-50 border border-green-200 rounded">
              <div className="flex items-center space-x-1.5">
                <svg
                  className="h-4 w-4 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-xs font-medium text-green-700">
                  Files uploaded
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={clearFiles}
                className="text-xs h-7"
              >
                Clear
              </Button>
            </div>
          ) : (
            <div className="flex space-x-1.5">
              <Button
                onClick={handleUpload}
                disabled={uploading}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-xs h-8"
              >
                {uploading ? 'Uploading...' : 'Upload'}
              </Button>
              <Button variant="outline" onClick={clearFiles} disabled={uploading} className="text-xs h-8">
                Clear
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
