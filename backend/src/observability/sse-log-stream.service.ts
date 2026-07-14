import { Injectable } from "@nestjs/common";
import { Response } from "express";
import { User } from "../users/user.entity";
import { CloudWatchLogsService, LogQueryOptions } from "./cloudwatch-logs.service";

@Injectable()
export class SseLogStreamService {
  constructor(private readonly cloudWatchLogs: CloudWatchLogsService) {}

  stream(projectId: string, options: LogQueryOptions, response: Response, actorUser?: User | null) {
    return this.cloudWatchLogs.streamLogsToSse(projectId, options, response, actorUser);
  }
}
