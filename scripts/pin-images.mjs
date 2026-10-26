// One-off helper that records the exact image digests the catalog was tested with.
// Usage: node scripts/pin-images.mjs  (edit the table below when you re-test newer versions)
import { readFileSync, writeFileSync } from "node:fs";

const pins = {
  prowlarr: ["2.6.5.5623", "sha256:b3b00047ed20f6ce2b16780145cb6a0acb51c9e28ea6aa6f5dcd33c7034f1797"],
  sonarr: ["4.0.20.3014", "sha256:48e36b608b461273b9dae857725cd0561a127f2c694b687318f6d0c5ce63e5c9"],
  radarr: ["6.4.4.10685", "sha256:084b3b2ab1d0ef930660727259546a241f2bdf67c9ed085d54bf1486a6887c9b"],
  qbittorrent: ["5.3.0", "sha256:75ecbb1c89ab7b0a21c4bde40b4820e4f1649d2d56d83b91913422155e8d2a5f"],
  jellyfin: ["12.3.0", "sha256:4212ca390fbc6bd5002048d2d2ce2b8a5b1ad278ec4cbabe6519869117404308"],
  seerr: ["3.5.1", "sha256:d8fab675b55ad293ded98fd71efcfd46054cbad9746534ae1cc4794a88c0b3be"],
  gluetun: ["2026-10-19", "sha256:c2ee4191762fca6b6a3c3359a731198a95d9c9af4db32d466e223bf3a84e779b"],
};

for (const [id, [version, digest]] of Object.entries(pins)) {
  const file = new URL(`../packages/core/manifests/${id}.yaml`, import.meta.url);
  let yaml = readFileSync(file, "utf8");
  yaml = yaml.replace(/^digest: .*\n/m, "");
  yaml = yaml.replace(/^tag: .*$/m, `tag: "${version}"\ndigest: ${digest}`);
  yaml = /^testedVersion: .*$/m.test(yaml)
    ? yaml.replace(/^testedVersion: .*$/m, `testedVersion: "${version}"`)
    : yaml.replace(/^digest: .*$/m, (m) => `${m}\ntestedVersion: "${version}"`);
  writeFileSync(file, yaml);
  console.log(`pinned ${id} ${version}`);
}
