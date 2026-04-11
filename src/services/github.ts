// GitHub service — fetches repo as a zipball
import { Readable } from "node:stream";

const GITHUB_API = "https://api.github.com";

async function assertBranchExists(repo: string, branch: string, token: string, onProgress?: (msg: string) => void) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo}`);

  onProgress?.("Checking GitHub branch...");
  const refRes = await fetch(`${GITHUB_API}/repos/${owner}/${name}/branches/${branch}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!refRes.ok) {
    const err = await refRes.text();
    throw new Error(`GitHub branch not found (${refRes.status}): ${err}`);
  }

  return { owner, name };
}

export async function fetchRepoZipStream(
  repo: string,
  branch: string,
  token: string,
  onProgress?: (msg: string) => void
): Promise<Readable> {
  const { owner, name } = await assertBranchExists(repo, branch, token, onProgress);

  onProgress?.(`Downloading source from GitHub (${owner}/${name}@${branch})...`);
  const zipRes = await fetch(`${GITHUB_API}/repos/${owner}/${name}/zipball/${branch}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.zip",
    },
  });

  if (!zipRes.ok) {
    const err = await zipRes.text();
    throw new Error(`GitHub zipball download failed (${zipRes.status}): ${err}`);
  }

  if (!zipRes.body) {
    throw new Error("GitHub zipball response did not include a body stream");
  }

  return Readable.fromWeb(zipRes.body as any);
}

export async function fetchRepoZip(
  repo: string,
  branch: string,
  token: string,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
  const stream = await fetchRepoZipStream(repo, branch, token, onProgress);
  return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
}
