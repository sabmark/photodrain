import Store from "electron-store";
import type { UserProfile } from "./types.js";

export interface SettingsSchema {
  activeProfileId: string | null;
  profiles: UserProfile[];
  backupFolder: string | null;
  archiveSize: "2GB" | "4GB" | "10GB" | "50GB";
  emptyTrashTypedConfirmation: string;
}

export const DEFAULT_PROFILE_ID = "default";

export const settingsStore = new Store<SettingsSchema>({
  name: "settings",
  defaults: {
    activeProfileId: null,
    profiles: [],
    backupFolder: null,
    archiveSize: "50GB",
    emptyTrashTypedConfirmation: ""
  }
});

const profileColors = ["#2563eb", "#059669", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#be123c"];
const PENDING_PROFILE_NAME = "Sign in to Google";

function withProfileDefaults(profile: UserProfile, index: number): UserProfile {
  return {
    avatarDataUrl: null,
    backupRootFolder: null,
    googleEmail: null,
    googleName: null,
    pendingLogin: false,
    previousProfileId: null,
    color: profile.color ?? profileColors[index % profileColors.length],
    ...profile
  };
}

export function ensureProfiles() {
  const profiles = settingsStore.get("profiles") ?? [];
  const activeProfileId = settingsStore.get("activeProfileId") ?? DEFAULT_PROFILE_ID;
  const legacyBackupFolder = settingsStore.get("backupFolder") ?? null;

  if (profiles.length === 0) {
    settingsStore.set("profiles", []);
    settingsStore.set("activeProfileId", null);
    return;
  }

  const normalizedProfiles = profiles.map(withProfileDefaults);
  if (JSON.stringify(normalizedProfiles) !== JSON.stringify(profiles)) {
    settingsStore.set("profiles", normalizedProfiles);
  }

  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    settingsStore.set("activeProfileId", profiles[0].id);
  }

  if (legacyBackupFolder && profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID && !profile.backupFolder && !profile.backupRootFolder)) {
    settingsStore.set("profiles", normalizedProfiles.map((profile) => profile.id === DEFAULT_PROFILE_ID ? { ...profile, backupRootFolder: legacyBackupFolder, backupFolder: legacyBackupFolder } : profile));
  }
}

export function isPendingProfile(profile: UserProfile) {
  return profile.pendingLogin === true && profile.name === PENDING_PROFILE_NAME && !profile.googleEmail && !profile.googleName;
}

export function prunePendingProfiles(preserveIds: string[] = []) {
  const preserve = new Set(preserveIds);
  const profiles = settingsStore.get("profiles") ?? [];
  const removedProfiles = profiles.filter((profile) => !preserve.has(profile.id) && isPendingProfile(profile));
  const nextProfiles = profiles.filter((profile) => preserve.has(profile.id) || !isPendingProfile(profile));
  if (nextProfiles.length === profiles.length) {
    return nextProfiles;
  }

  settingsStore.set("profiles", nextProfiles);
  const activeProfileId = settingsStore.get("activeProfileId");
  if (!activeProfileId || !nextProfiles.some((profile) => profile.id === activeProfileId)) {
    const removedActive = removedProfiles.find((profile) => profile.id === activeProfileId);
    const previousProfile = removedActive?.previousProfileId
      ? nextProfiles.find((profile) => profile.id === removedActive.previousProfileId)
      : null;
    settingsStore.set("activeProfileId", previousProfile?.id ?? nextProfiles[0]?.id ?? null);
  }
  return nextProfiles;
}

export function getProfiles() {
  ensureProfiles();
  return settingsStore.get("profiles");
}

export function getActiveProfile() {
  const profiles = getProfiles();
  const activeProfileId = settingsStore.get("activeProfileId");
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
}

export function updateActiveProfile(patch: Partial<UserProfile>) {
  const activeProfile = getActiveProfile();
  if (!activeProfile) {
    throw new Error("No active profile.");
  }
  const profiles = getProfiles().map((profile) => profile.id === activeProfile.id ? { ...profile, ...patch, id: profile.id } : profile);
  settingsStore.set("profiles", profiles);
  return profiles.find((profile) => profile.id === activeProfile.id) ?? activeProfile;
}

export function createProfile() {
  const id = `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const previousProfileId = settingsStore.get("activeProfileId") ?? null;
  const profile: UserProfile = withProfileDefaults({ id, name: PENDING_PROFILE_NAME, backupFolder: null, pendingLogin: true, previousProfileId }, getProfiles().length);
  settingsStore.set("profiles", [...getProfiles(), profile]);
  settingsStore.set("activeProfileId", id);
  return profile;
}

export function switchProfile(id: string) {
  const profile = getProfiles().find((item) => item.id === id);
  if (!profile) {
    throw new Error("Profile not found.");
  }
  settingsStore.set("activeProfileId", id);
  return profile;
}

export function deleteProfile(id: string) {
  const profiles = getProfiles();
  const nextProfiles = profiles.filter((profile) => profile.id !== id);
  if (nextProfiles.length === profiles.length) {
    throw new Error("Profile not found.");
  }
  settingsStore.set("profiles", nextProfiles);
  if (settingsStore.get("activeProfileId") === id) {
    settingsStore.set("activeProfileId", nextProfiles[0]?.id ?? null);
  }
  return getActiveProfile();
}
