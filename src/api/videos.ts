import { rm } from "fs/promises";
import path from "path";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { respondWithJSON } from "./json";
import { uploadVideoToS3 } from "../s3";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

import { type ApiConfig } from "../config";
import { file, type BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File exceeds size limit (1GB)");
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, only MP4 is allowed");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);

  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  let key = `${aspectRatio}/${videoId}.mp4`;

  const processedFilePath = await processVideoForFastStart(tempFilePath);
  await uploadVideoToS3(cfg, key, processedFilePath, "video/mp4");

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true }),
                     rm(`${tempFilePath}.processed.mp4`, {force : true}),
  ]);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe","-v","error", "-print_format","json","-show_streams",filePath], 
//    {
//    stdout: "inherit",
//    stderr: "pipe", 
//  }
);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error("Error spawning bun process");
  }


  const stdoutJson = await new Response(proc.stdout).json();
  const width = stdoutJson.streams[0].width;
  const height = stdoutJson.streams[0].height;
  console.log(`${width} ${height}`);

  if (Math.floor(width/16) == Math.floor(height / 9)) {
    return 'landscape';
  }

  if (Math.floor(width/9) == Math.floor(height / 16)) {
    return 'portrait';
  }

  return 'other';
  
}

export async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed.mp4`;

  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" },
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}
