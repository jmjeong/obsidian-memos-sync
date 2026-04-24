import { requestUrl, RequestUrlParam } from "obsidian";
import { ListMemosResponse, Memo, Resource } from "./types";

export class MemosClient {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request(path: string, params?: Record<string, string>): Promise<any> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += `?${qs}`;
    }
    const req: RequestUrlParam = { url, headers: this.headers, method: "GET" };
    const resp = await requestUrl(req);
    return resp.json;
  }

  async getMe(): Promise<{ name: string; displayName: string; username: string }> {
    // v0.27.1 has no /auth/status endpoint.
    // List one memo to get the creator field, then fetch that user.
    const resp = await this.request("/api/v1/memos", { pageSize: "1" });
    const memos = resp.memos || [];
    if (!memos.length) {
      throw new Error("No memos found. Cannot determine user.");
    }
    const creator: string = memos[0].creator; // e.g. "users/jmjeong"
    const username = creator.replace("users/", "");
    return this.request(`/api/v1/users/${username}`);
  }

  async listMemos(pageSize: number, pageToken?: string): Promise<ListMemosResponse> {
    const params: Record<string, string> = {
      pageSize: String(pageSize),
      orderBy: "display_time desc",
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }
    return this.request("/api/v1/memos", params);
  }

  async fetchResourceBinary(resource: Resource): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}/file/${resource.name}/${resource.filename}`;
    const req: RequestUrlParam = {
      url,
      headers: this.headers,
      method: "GET",
    };
    const resp = await requestUrl(req);
    return resp.arrayBuffer;
  }
}
