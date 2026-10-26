import type { WireContext } from "./context.js";
import { jsonClient, waitUntil } from "./http.js";

const CLIENT = 'MediaBrowser Client="Homeport", Device="Homeport", DeviceId="homeport", Version="0.1"';

const LIBRARIES = [
  { name: "Movies", type: "movies", path: "/data/media/movies" },
  { name: "TV Shows", type: "tvshows", path: "/data/media/tv" },
] as const;

/** Finish Jellyfin's first-run wizard, then make sure the Movies and TV libraries exist. */
export async function wireJellyfin(ctx: WireContext): Promise<void> {
  const base = ctx.url("jellyfin");
  const open = jsonClient(ctx, base, { Authorization: CLIENT }, "Jellyfin");
  let info: { StartupWizardCompleted?: boolean } = {};
  await waitUntil(ctx, "Jellyfin", async () => {
    info = await open("GET", "/System/Info/Public");
  });

  const { adminUser, adminPassword } = ctx.jellyfin;
  if (!info.StartupWizardCompleted) {
    await open("POST", "/Startup/Configuration", {
      UICulture: "en-US",
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
    });
    await open("GET", "/Startup/User"); // creates the initial user record the wizard edits
    await open("POST", "/Startup/User", { Name: adminUser, Password: adminPassword });
    await open("POST", "/Startup/RemoteAccess", {
      EnableRemoteAccess: true,
      EnableAutomaticPortMapping: false,
    });
    await open("POST", "/Startup/Complete");
    ctx.log(`Jellyfin: finished first-run setup (admin user '${adminUser}')`);
  }

  const auth = await open<{ AccessToken: string }>("POST", "/Users/AuthenticateByName", {
    Username: adminUser,
    Pw: adminPassword,
  });
  const authed = jsonClient(
    ctx,
    base,
    { Authorization: `${CLIENT}, Token="${auth.AccessToken}"` },
    "Jellyfin",
  );
  const have = await authed<{ Name: string }[]>("GET", "/Library/VirtualFolders");
  for (const lib of LIBRARIES) {
    if (have.some((f) => f.Name === lib.name)) continue;
    await authed(
      "POST",
      `/Library/VirtualFolders?name=${encodeURIComponent(lib.name)}&collectionType=${lib.type}&refreshLibrary=true`,
      { LibraryOptions: { PathInfos: [{ Path: lib.path }] } },
    );
    ctx.log(`Jellyfin: added library ${lib.name}`);
  }
}
