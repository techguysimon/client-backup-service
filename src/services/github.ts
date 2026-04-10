// GitHub service — fetches repo as a zipball
const GITHUB_API = "https://api.github.com";

export async function fetchRepoZip(
  repo: string,
  branch: string,
  token: string,
  onProgress?: (msg: string) => void
): Promise<Uint8Array> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo format: ${repo}`);

  // Check the ref exists first
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

  // Download the zipball
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

  const arrayBuffer = await zipRes.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
