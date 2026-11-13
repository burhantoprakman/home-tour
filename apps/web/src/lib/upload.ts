'use client';

import {
  VIDEO_CONTENT_TYPES,
  type ResumableUpload,
  type RoomUploadedResponse,
  type VideoContentType,
} from '@home-tour/shared';
import { api } from './api';
import { authHeaders } from './supabase';
import { tusUpload } from './tus';

const EXTENSIONS: Record<string, VideoContentType> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** The upload content type of a picked video (some browsers leave `file.type` empty for .mov). */
export function videoContentType(file: File): VideoContentType | null {
  if (file.type in VIDEO_CONTENT_TYPES) return file.type as VideoContentType;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && EXTENSIONS[ext]) || null;
}

/** Sends the video (resuming if this file was partly sent before), then starts processing. */
export async function uploadRoomVideo(
  roomId: string,
  upload: ResumableUpload,
  file: File,
  onProgress: (sent: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RoomUploadedResponse> {
  await tusUpload({
    upload,
    file,
    headers: authHeaders,
    onProgress,
    ...(signal ? { signal } : {}),
  });
  return api<RoomUploadedResponse>(`/api/rooms/${roomId}/uploaded`, { method: 'POST', body: {} });
}
