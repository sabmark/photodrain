import { AlertCircle, Check, ChevronDown, Clock3, Database, FolderOpen, HardDrive, Loader2, LogOut, Mail, Plus, RefreshCw, ShieldAlert, Square, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import packageJson from "../../package.json";
import type { AppState, AutomationLogEntry, StorageUsageSummary, WorkflowStep } from "../../electron/types";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { formatBytes } from "./lib/utils";

const steps: { id: WorkflowStep; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "backup-folder", label: "Backup folder" },
  { id: "download-export", label: "Download ZIPs" },
  { id: "backup-summary", label: "Backup summary" },
  { id: "photos-cleanup", label: "Photos cleanup" },
  { id: "empty-trash", label: "Empty trash" },
  { id: "logs-settings", label: "Logs" }
];

const DEFAULT_ARCHIVE_SIZE = "50GB";
const FINAL_DELETE_CONFIRMATION = "DELETE";
const APP_VERSION = packageJson.version;

function getSidebarWidth(windowWidth: number) {
  if (windowWidth < 900) {
    return 72;
  }
  if (windowWidth < 1024) {
    return 220;
  }
  return 260;
}

function clampBrowserWidth(width: number) {
  const sidebarWidth = getSidebarWidth(window.innerWidth);
  const mainWidth = window.innerWidth >= 1200 ? 420 : 360;
  const maxWidth = Math.max(280, window.innerWidth - sidebarWidth - mainWidth);
  return Math.max(280, Math.min(width, maxWidth));
}

function getDefaultBrowserWidth() {
  return clampBrowserWidth(window.innerWidth);
}

const emptyState: AppState = {
  profiles: [],
  activeProfileId: null,
  activeProfileName: null,
  profileRefreshActive: false,
  backupFolder: null,
  backupRootFolder: null,
  currentUrl: null,
  isGoogleLoggedIn: false,
  status: "idle",
  downloadsComplete: false,
  downloadedFiles: [],
  totalDownloadedBytes: 0,
  activeDownloadCount: 0,
  pausedDownloadCount: 0,
  logs: [],
  browserVisible: false,
  lastScreenshotPath: null
};

export function App() {
  const [activeStep, setActiveStep] = useState<WorkflowStep>("welcome");
  const [state, setState] = useState<AppState>(emptyState);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileActionPending, setProfileActionPending] = useState(false);
  const [profileLoginActive, setProfileLoginActive] = useState(false);
  const [continueAfterProfileLogin, setContinueAfterProfileLogin] = useState(false);
  const [loginCheckPending, setLoginCheckPending] = useState(false);
  const [folderActionPending, setFolderActionPending] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [understandsDelete, setUnderstandsDelete] = useState(false);
  const [trashEmptied, setTrashEmptied] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsageSummary | null>(null);
  const [storageUsagePending, setStorageUsagePending] = useState(false);
  const [storageUsageError, setStorageUsageError] = useState<string | null>(null);
  const [browserPanelWidth, setBrowserPanelWidth] = useState(getDefaultBrowserWidth);
  const [browserUserResized, setBrowserUserResized] = useState(false);
  const photosCleanupOpenedRef = useRef(false);
  const loadedStorageProfileRef = useRef<string | null>(null);
  const hasActiveDownload = state.activeDownloadCount > 0;
  const hasProfiles = state.profiles.length > 0;

  useEffect(() => {
    void window.photoDrain.getState().then(async (initialState: AppState) => {
      setState(initialState);
      if (initialState.profiles.length > 0) {
        await window.photoDrain.checkLoginStatus();
        setState(await window.photoDrain.getState());
      }
    });
    const offState = window.photoDrain.onState(setState);
    const offLog = window.photoDrain.onLog((entry: AutomationLogEntry) => {
      setState((current) => ({ ...current, logs: [...current.logs, entry].slice(-1000) }));
    });
    return () => {
      offState();
      offLog();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setBrowserPanelWidth((current) => browserUserResized ? clampBrowserWidth(current) : getDefaultBrowserWidth());
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [browserUserResized]);

  useEffect(() => {
    if (state.browserVisible && !browserUserResized) {
      const nextWidth = getDefaultBrowserWidth();
      setBrowserPanelWidth(nextWidth);
      void window.photoDrain.setBrowserWidth(nextWidth);
    }
  }, [browserUserResized, state.browserVisible]);

  useEffect(() => {
    if (state.browserVisible) {
      void window.photoDrain.setBrowserWidth(browserPanelWidth);
    }
  }, [browserPanelWidth, state.browserVisible]);

  useEffect(() => {
    const browserSteps: WorkflowStep[] = ["takeout-request", "download-export", "backup-summary", "photos-cleanup", "empty-trash"];
    const shouldShowBrowser = profileLoginActive || browserSteps.includes(activeStep);

    if (shouldShowBrowser && !state.browserVisible) {
      void window.photoDrain.showBrowser();
    }
    if (!shouldShowBrowser && state.browserVisible) {
      void window.photoDrain.hideBrowser();
    }
  }, [activeStep, profileLoginActive, state.browserVisible]);

  useEffect(() => {
    if (activeStep === "download-export" && state.status !== "running" && !hasActiveDownload) {
      void window.photoDrain.validateDownloads().then(() => window.photoDrain.getState()).then(setState);
    }
  }, [activeStep, hasActiveDownload, state.status]);

  const canEmptyTrash = useMemo(
    () => Boolean(state.backupFolder && state.downloadsComplete && deleteText === FINAL_DELETE_CONFIRMATION && understandsDelete),
    [deleteText, state.backupFolder, state.downloadsComplete, understandsDelete]
  );

  useEffect(() => {
    if (activeStep === "download-export" && state.status === "completed" && state.downloadsComplete && !hasActiveDownload) {
      setActiveStep("backup-summary");
    }
  }, [activeStep, hasActiveDownload, state.downloadsComplete, state.status]);

  useEffect(() => {
    if (!state.browserVisible) {
      return;
    }

    if (activeStep === "download-export" || activeStep === "backup-summary" || activeStep === "photos-cleanup") {
      void window.photoDrain.setBrowserInteractionLocked(true);
      return;
    }

    if (!hasActiveDownload && state.status !== "running") {
      void window.photoDrain.setBrowserInteractionLocked(false);
    }
  }, [activeStep, hasActiveDownload, state.browserVisible, state.status]);

  useEffect(() => {
    if (activeStep === "photos-cleanup" && state.downloadsComplete && !photosCleanupOpenedRef.current) {
      photosCleanupOpenedRef.current = true;
      void run(window.photoDrain.startPhotosCleanup);
    }
  }, [activeStep, state.downloadsComplete]);

  useEffect(() => {
    if (state.profileRefreshActive) {
      setProfileMenuOpen(false);
    }
  }, [state.profileRefreshActive]);

  useEffect(() => {
    if (activeStep !== "welcome" || profileLoginActive || !state.activeProfileId || storageUsagePending) {
      return;
    }
    if (loadedStorageProfileRef.current === state.activeProfileId) {
      return;
    }
    loadedStorageProfileRef.current = state.activeProfileId;
    void refreshStorageUsage();
  }, [activeStep, profileLoginActive, state.activeProfileId, storageUsagePending]);

  useEffect(() => {
    if (!profileLoginActive) {
      return;
    }

    let canceled = false;
    let running = false;
    const poll = async () => {
      if (running || loginCheckPending || state.profileRefreshActive) {
        return;
      }
      running = true;
      const completed = await completeProfileLogin(false);
      running = false;
      if (completed || canceled) {
        window.clearInterval(intervalId);
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, 2500);
    void poll();

    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [continueAfterProfileLogin, loginCheckPending, profileLoginActive, state.profileRefreshActive]);

  async function run(action: () => Promise<unknown>) {
    setLastResult(null);
    const result = await action();
    if (result && typeof result === "object" && "message" in result) {
      setLastResult(String((result as { message: string }).message));
    }
    setState(await window.photoDrain.getState());
  }

  async function refreshStorageUsage() {
    if (!state.activeProfileId || storageUsagePending) {
      return;
    }
    setStorageUsagePending(true);
    setStorageUsageError(null);
    try {
      const summary = await window.photoDrain.getStorageUsage();
      setStorageUsage(summary);
    } catch (error) {
      loadedStorageProfileRef.current = null;
      setStorageUsage(null);
      setStorageUsageError(error instanceof Error ? error.message : String(error));
    } finally {
      setStorageUsagePending(false);
      setState(await window.photoDrain.getState());
    }
  }

  async function requestExportThenDownload() {
    setActiveStep("download-export");
    const result = await window.photoDrain.requestTakeoutExport(DEFAULT_ARCHIVE_SIZE);
    if (result && typeof result === "object" && "message" in result) {
      setLastResult(String((result as { message: string }).message));
    }
    setState(await window.photoDrain.getState());
  }

  async function selectBackupFolderAndContinue() {
    if (folderActionPending) {
      return;
    }

    setFolderActionPending(true);
    try {
      setLastResult(null);
      if (!hasProfiles) {
        setLastResult("Add a Google profile before starting the workflow.");
        return;
      }
      const folder = await window.photoDrain.selectBackupFolder();
      if (!folder) {
        setState(await window.photoDrain.getState());
        return;
      }

      const isLoggedIn = await window.photoDrain.checkLoginStatus();
      if (isLoggedIn) {
        await requestExportThenDownload();
        return;
      }

      setProfileLoginActive(true);
      setContinueAfterProfileLogin(true);
      setLastResult("Google needs you to sign in again. Use the visible browser, then click Finish Google sign-in.");
      await window.photoDrain.openGoogleLogin();
      setState(await window.photoDrain.getState());
    } finally {
      setFolderActionPending(false);
    }
  }

  async function continueWithSelectedFolder() {
    if (folderActionPending) {
      return;
    }

    setFolderActionPending(true);
    try {
      setLastResult(null);
      if (!hasProfiles) {
        setLastResult("Add a Google profile before starting the workflow.");
        return;
      }
      const currentState = await window.photoDrain.getState();
      if (!currentState.backupRootFolder || !currentState.backupFolder) {
        setLastResult("Select a backup root folder before continuing.");
        setState(currentState);
        return;
      }

      const isLoggedIn = await window.photoDrain.checkLoginStatus();
      if (isLoggedIn) {
        await requestExportThenDownload();
        return;
      }

      setProfileLoginActive(true);
      setContinueAfterProfileLogin(true);
      setLastResult("Google needs you to sign in again. Use the visible browser, then click Finish Google sign-in.");
      await window.photoDrain.openGoogleLogin();
      setState(await window.photoDrain.getState());
    } finally {
      setFolderActionPending(false);
    }
  }

  async function completeProfileLogin(showFailureMessage: boolean) {
    if (loginCheckPending) {
      return false;
    }

    setLoginCheckPending(true);
    if (showFailureMessage) {
      setLastResult(null);
    }
    try {
      const isLoggedIn = await window.photoDrain.checkLoginStatus();
      if (isLoggedIn) {
        const nextState = await window.photoDrain.getState();
        setProfileLoginActive(false);
        const shouldContinue = continueAfterProfileLogin;
        setContinueAfterProfileLogin(false);
        setLastResult("Google profile session saved.");
        setState(nextState);
        if (shouldContinue) {
          await requestExportThenDownload();
          return true;
        }
        setActiveStep("welcome");
        return true;
      }

      if (showFailureMessage) {
        setLastResult("No saved Google session found yet. Finish Google sign-in in the visible browser, then try again.");
      }
      setState(await window.photoDrain.getState());
      return false;
    } finally {
      setLoginCheckPending(false);
    }
  }

  async function finishProfileLogin() {
    await completeProfileLogin(true);
  }

  async function createNewProfile() {
    if (profileActionPending) {
      return;
    }

    setProfileActionPending(true);
    try {
      setLastResult("Sign in to Google in the visible browser. The profile name, email, and photo will be cached after login.");
      const nextState = await window.photoDrain.createProfile();
      setProfileMenuOpen(false);
      setProfileLoginActive(true);
      setContinueAfterProfileLogin(false);
      loadedStorageProfileRef.current = null;
      setStorageUsage(null);
      setStorageUsageError(null);
      photosCleanupOpenedRef.current = false;
      setTrashEmptied(false);
      setDeleteText("");
      setUnderstandsDelete(false);
      setState(nextState);
    } finally {
      setProfileActionPending(false);
    }
  }

  async function switchActiveProfile(id: string) {
    if (id === state.activeProfileId) {
      return;
    }
    setLastResult(null);
    const nextState = await window.photoDrain.switchProfile(id);
    setProfileMenuOpen(false);
    setProfileLoginActive(false);
    setContinueAfterProfileLogin(false);
    loadedStorageProfileRef.current = null;
    setStorageUsage(null);
    setStorageUsageError(null);
    setActiveStep("welcome");
    photosCleanupOpenedRef.current = false;
    setTrashEmptied(false);
    setDeleteText("");
    setUnderstandsDelete(false);
    setState(nextState);
  }

  async function deleteActiveProfile() {
    if (!state.activeProfileId) {
      return;
    }
    setLastResult(null);
    const nextState = await window.photoDrain.deleteProfile(state.activeProfileId);
    setProfileMenuOpen(false);
    setProfileLoginActive(false);
    setContinueAfterProfileLogin(false);
    loadedStorageProfileRef.current = null;
    setStorageUsage(null);
    setStorageUsageError(null);
    setActiveStep("welcome");
    photosCleanupOpenedRef.current = false;
    setTrashEmptied(false);
    setDeleteText("");
    setUnderstandsDelete(false);
    setState(nextState);
  }

  async function emptyTrashAndFinish() {
    setLastResult(null);
    const result = await window.photoDrain.emptyTrash({ typedConfirmation: deleteText, understandsPermanentDelete: understandsDelete });
    if (result && typeof result === "object" && "message" in result) {
      setLastResult(String((result as { message: string }).message));
    }
    if (result && typeof result === "object" && "ok" in result && (result as { ok: boolean }).ok) {
      setTrashEmptied(true);
      await window.photoDrain.hideBrowser();
      setActiveStep("logs-settings");
    }
    setState(await window.photoDrain.getState());
  }

  function startBrowserResize(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    setBrowserUserResized(true);

    const updateWidth = (clientX: number) => {
      const nextWidth = clampBrowserWidth(window.innerWidth - clientX);
      setBrowserPanelWidth(nextWidth);
      void window.photoDrain.setBrowserWidth(nextWidth);
    };

    const onMouseMove = (moveEvent: MouseEvent) => updateWidth(moveEvent.clientX);
    const onMouseUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    updateWidth(event.clientX);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen min-w-0">
        <aside className="w-[72px] shrink-0 border-r border-border bg-card px-2 py-4 min-[900px]:w-[220px] min-[900px]:px-3 lg:w-[260px] lg:px-4 lg:py-5">
          <div className="mb-5">
            <h1 className="text-center text-lg font-semibold min-[900px]:text-left min-[900px]:text-xl lg:text-2xl">
              <span className="min-[900px]:hidden">PD</span>
              <span className="hidden min-[900px]:inline">PhotoDrain</span>
            </h1>
            <p className="mt-1 hidden text-xs text-muted-foreground min-[900px]:block lg:text-sm">A private desktop workspace for Google Photos backup and cleanup.</p>
          </div>
          <ProfileSwitcher
            activeProfileId={state.activeProfileId}
            profileActionPending={profileActionPending || state.profileRefreshActive}
            profileRefreshActive={state.profileRefreshActive}
            profiles={state.profiles}
            onCreate={createNewProfile}
            onDelete={deleteActiveProfile}
            onSwitch={switchActiveProfile}
            open={profileMenuOpen}
            setOpen={setProfileMenuOpen}
          />
          <nav className="space-y-1">
            {steps.map((step, index) => (
              <button
                key={step.id}
                title={step.label}
                className={`flex w-full items-center justify-center gap-3 rounded-md px-2 py-2 text-left text-sm transition min-[900px]:justify-start min-[900px]:px-3 ${
                  !profileLoginActive && activeStep === step.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
                onClick={() => setActiveStep(step.id)}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current text-xs">{index + 1}</span>
                <span className="hidden min-[900px]:inline">{step.label}</span>
              </button>
            ))}
          </nav>
          <div className="mt-5 hidden rounded-md border border-border p-3 text-xs text-muted-foreground min-[900px]:block">
            <div>Status: <span className="font-medium text-foreground">{state.status}</span></div>
          </div>
        </aside>

        <main className={`min-w-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 ${state.browserVisible ? "min-[1200px]:max-w-[420px]" : ""}`}>
          {lastResult && <div className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">{lastResult}</div>}

          {profileLoginActive ? (
            <ProfileLoginView
              loginCheckPending={loginCheckPending}
              onClearSession={() => run(window.photoDrain.clearGoogleSession)}
              onFinish={finishProfileLogin}
              onOpenLogin={() => run(window.photoDrain.openGoogleLogin)}
            />
          ) : activeStep === "welcome" && (
            <Screen title="Overview" description="Review the active Google profile and storage usage before starting a backup workflow.">
              <WelcomeView
                activeProfile={state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0] ?? null}
                hasProfiles={hasProfiles}
                storageError={storageUsageError}
                storagePending={storageUsagePending || state.profileRefreshActive}
                storageSummary={storageUsage}
                onRefreshStorage={() => {
                  loadedStorageProfileRef.current = null;
                  void refreshStorageUsage();
                }}
                onStart={() => setActiveStep("backup-folder")}
              />
            </Screen>
          )}

          {!profileLoginActive && activeStep === "backup-folder" && (
            <Screen title="Select Backup Root Folder" description="Choose a root folder. PhotoDrain creates a dated backup folder inside it for today's Takeout ZIP files.">
              <Card className="p-4">
                <div className="text-sm text-muted-foreground">Selected root folder</div>
                <div className="mt-1 break-all font-medium">{state.backupRootFolder || "No root folder selected"}</div>
                <div className="mt-4 text-sm text-muted-foreground">Today's save folder</div>
                <div className="mt-1 break-all font-medium">{state.backupFolder || "Created after selecting a root folder"}</div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {state.backupRootFolder && (
                    <Button disabled={folderActionPending} onClick={continueWithSelectedFolder}>
                      {folderActionPending ? "Continuing..." : "Continue with selected root"}
                    </Button>
                  )}
                  <Button disabled={folderActionPending} variant={state.backupRootFolder ? "secondary" : "primary"} icon={<FolderOpen size={16} />} onClick={selectBackupFolderAndContinue}>
                    {folderActionPending ? "Working..." : state.backupRootFolder ? "Choose different root" : "Choose root folder"}
                  </Button>
                </div>
              </Card>
            </Screen>
          )}

          {!profileLoginActive && activeStep === "takeout-request" && (
            <Screen title="Checking Takeout Export" description="PhotoDrain is checking Manage exports, reusing any in-progress export, or creating a Google Photos export if none exists.">
              <Card className="p-4 text-sm">
                Takeout sync is running with ZIP format and {DEFAULT_ARCHIVE_SIZE} archive size.
              </Card>
            </Screen>
          )}

          {!profileLoginActive && activeStep === "download-export" && (
            <Screen title="Wait And Download Export ZIPs" description="PhotoDrain checks Google Takeout Manage exports first, waits for an in-progress export to become ready, then downloads ZIP files to the selected backup folder.">
              {state.activeDownloadCount > 0 && (
                <div className="mt-3 space-y-3 rounded-md border border-border bg-muted px-3 py-3 text-sm">
                  <div>Active downloads: {state.activeDownloadCount}. Canceling deletes incomplete local files.</div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="destructive" icon={<Square size={16} />} onClick={() => run(window.photoDrain.cancelDownloads)}>Cancel download</Button>
                  </div>
                </div>
              )}
            </Screen>
          )}

          {!profileLoginActive && activeStep === "backup-summary" && (
            <Screen title="Backup Completed Summary" description="Review downloaded ZIP files before any Google Photos cleanup action is enabled.">
              <DownloadSummary state={state} />
              <div className="mt-4 flex flex-wrap gap-2">
                <Button disabled={!state.downloadsComplete} onClick={() => setActiveStep("photos-cleanup")}>
                  Proceed to Photos cleanup
                </Button>
              </div>
            </Screen>
          )}

          {!profileLoginActive && activeStep === "photos-cleanup" && (
            <Screen title="Google Photos Cleanup" description="PhotoDrain opens Photos, selects the backed-up items, and moves them to trash automatically. Emptying trash remains a separate final confirmation step.">
              <Card className="space-y-4 p-4">
                <div className="text-sm text-muted-foreground">
                  Cleanup automation runs automatically when this step opens.
                </div>
                <Button disabled={state.status === "running"} onClick={() => setActiveStep("empty-trash")}>
                  Continue to empty trash confirmation
                </Button>
              </Card>
            </Screen>
          )}

          {!profileLoginActive && activeStep === "empty-trash" && (
            <Screen title="Empty Trash Confirmation" description="After this local confirmation, PhotoDrain opens Google Photos Trash and clicks Empty trash automatically.">
              <Card className="space-y-4 p-4">
                <div className="flex items-start gap-3 text-sm">
                  <ShieldAlert className="mt-0.5 shrink-0 text-destructive" size={18} />
                  <span>This may permanently delete photos. Confirm backups first.</span>
                </div>
                <input disabled={trashEmptied} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50" value={deleteText} onChange={(event) => setDeleteText(event.target.value)} placeholder={`Type ${FINAL_DELETE_CONFIRMATION}`} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={trashEmptied} checked={understandsDelete} onChange={(event) => setUnderstandsDelete(event.target.checked)} />
                  I understand this may permanently delete photos.
                </label>
                <Button variant="destructive" disabled={!canEmptyTrash || trashEmptied} onClick={emptyTrashAndFinish}>
                  Empty trash
                </Button>
              </Card>
            </Screen>
          )}

          {!profileLoginActive && activeStep === "logs-settings" && (
            <Screen title="Logs And Settings" description="Local automation logs and deletion screenshots are stored in Electron user data.">
              <Button variant="secondary" onClick={() => run(window.photoDrain.openLogsFolder)}>Open logs folder</Button>
              <LogViewer logs={state.logs} />
            </Screen>
          )}
        </main>

        {state.browserVisible && (
          <div
            className="z-10 w-1.5 shrink-0 cursor-col-resize border-l border-r border-border bg-muted transition hover:bg-primary/25"
            onMouseDown={startBrowserResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize browser panel"
            title="Resize browser panel"
          />
        )}

        <section
          className={`${state.browserVisible ? "block" : "hidden w-0"} shrink-0 bg-muted/40`}
          style={state.browserVisible ? { width: browserPanelWidth } : undefined}
        >
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            The visible Google browser session is docked here when shown.
          </div>
        </section>
      </div>
    </div>
  );
}

function Screen({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ProfileLoginView({
  loginCheckPending,
  onClearSession,
  onFinish,
  onOpenLogin
}: {
  loginCheckPending: boolean;
  onClearSession: () => void;
  onFinish: () => void;
  onOpenLogin: () => void;
}) {
  return (
    <Screen title="Google Profile Sign-In" description="This is profile setup, not a workflow step. Sign in manually in the visible browser so PhotoDrain can save this profile's local Google session.">
      <Card className="space-y-4 border-primary/40 p-4">
        <div className="text-sm leading-6 text-muted-foreground">
          PhotoDrain caches only the local browser session plus the Google account name, email, and profile photo. It never asks for or stores your password.
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<RefreshCw size={16} />} disabled={loginCheckPending} onClick={onFinish}>
            {loginCheckPending ? "Checking..." : "Finish Google sign-in"}
          </Button>
          <Button variant="secondary" icon={<LogOut size={16} />} onClick={onOpenLogin}>
            Open Google sign-in
          </Button>
          <Button variant="destructive" icon={<Trash2 size={16} />} onClick={onClearSession}>
            Clear saved session
          </Button>
        </div>
      </Card>
    </Screen>
  );
}

function ProfileSwitcher({
  activeProfileId,
  profileActionPending,
  profileRefreshActive,
  profiles,
  onCreate,
  onDelete,
  onSwitch,
  open,
  setOpen
}: {
  activeProfileId: string | null;
  profileActionPending: boolean;
  profileRefreshActive: boolean;
  profiles: AppState["profiles"];
  onCreate: () => void;
  onDelete: () => void;
  onSwitch: (id: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const activeDisplayName = activeProfile?.googleName || activeProfile?.name || "Profile";
  const activeSubtitle = activeProfile?.googleEmail || activeProfile?.backupFolder || "No Google account cached yet";

  if (!activeProfile) {
    return (
      <div className="relative mb-5">
        <Button
          className="w-full px-2 min-[900px]:px-3"
          disabled={profileActionPending}
          variant="secondary"
          icon={<Plus size={15} />}
          onClick={onCreate}
          title="Add Google profile"
        >
          <span className="hidden min-[900px]:inline">{profileActionPending ? "Opening Google..." : "Add Google profile"}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="relative mb-5">
      <button
        className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background p-2 text-left transition hover:bg-muted disabled:cursor-wait disabled:opacity-80 min-[900px]:justify-start min-[900px]:p-2.5"
        disabled={profileRefreshActive}
        onClick={() => setOpen(!open)}
        title="Switch profile"
      >
        <ProfileAvatar loading={profileRefreshActive} profile={activeProfile} size="md" />
        <div className="hidden min-w-0 flex-1 min-[900px]:block">
          <div className="truncate text-sm font-medium">{profileRefreshActive ? "Loading profile..." : activeDisplayName}</div>
          <div className="truncate text-xs text-muted-foreground">{profileRefreshActive ? "Refreshing Google account details" : activeSubtitle}</div>
        </div>
        <ChevronDown className={`hidden shrink-0 text-muted-foreground min-[900px]:block ${profileRefreshActive ? "animate-spin" : ""}`} size={16} />
      </button>

      {open && !profileRefreshActive && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-24px))] rounded-md border border-border bg-card p-3 shadow-xl">
          <div className="flex items-center gap-3 border-b border-border pb-3">
            <ProfileAvatar profile={activeProfile} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{activeDisplayName}</div>
              <div className="truncate text-xs text-muted-foreground">{activeProfile.googleEmail || "Google details cache after login check"}</div>
            </div>
          </div>

          <div className="mt-3 max-h-64 space-y-1 overflow-auto">
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfileId;
              const profileName = profile.googleName || profile.name;
              return (
                <div key={profile.id} className={`rounded-md border px-2 py-2 ${isActive ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"}`}>
                  <div className="flex items-center gap-2">
                    <ProfileAvatar profile={profile} size="sm" />
                    <button className="min-w-0 flex-1 text-left" onClick={() => onSwitch(profile.id)}>
                      <div className="truncate text-sm font-medium">{profileName}</div>
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        {profile.googleEmail && <Mail size={12} />}
                        <span className="truncate">{profile.googleEmail || "Sign in required"}</span>
                      </div>
                    </button>
                    {isActive && <Check className="shrink-0 text-primary" size={16} />}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <Button className="w-full" disabled={profileActionPending} variant="secondary" icon={<Plus size={15} />} onClick={onCreate}>
              {profileActionPending ? "Opening Google..." : "Add Google profile"}
            </Button>
            <div className="mt-2 text-xs leading-5 text-muted-foreground">
              New profiles are named from the Google account you sign in with.
            </div>
            <Button className="mt-2 w-full" variant="ghost" onClick={onDelete}>
              Delete active profile
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileAvatar({ loading = false, profile, size }: { loading?: boolean; profile: AppState["profiles"][number]; size: "sm" | "md" | "lg" }) {
  const sizeClass = size === "lg" ? "h-14 w-14" : size === "md" ? "h-10 w-10" : "h-8 w-8";
  const iconSize = size === "lg" ? 24 : size === "md" ? 18 : 15;
  const initials = getInitials(profile.googleName || profile.name);

  return (
    <div className={`${sizeClass} relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white`} style={{ backgroundColor: profile.color || "#2563eb" }}>
      {profile.avatarDataUrl ? (
        <img className="h-full w-full object-cover" src={profile.avatarDataUrl} alt="" />
      ) : initials ? (
        <span>{initials}</span>
      ) : (
        <UserRound size={iconSize} />
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45">
          <Loader2 className="animate-spin text-white" size={iconSize} />
        </div>
      )}
    </div>
  );
}

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function WelcomeView({
  activeProfile,
  hasProfiles,
  storageError,
  storagePending,
  storageSummary,
  onRefreshStorage,
  onStart
}: {
  activeProfile: AppState["profiles"][number] | null;
  hasProfiles: boolean;
  storageError: string | null;
  storagePending: boolean;
  storageSummary: StorageUsageSummary | null;
  onRefreshStorage: () => void;
  onStart: () => void;
}) {
  const profileTitle = activeProfile?.googleName || activeProfile?.name || "No profile selected";
  const profileSubtitle = activeProfile?.googleEmail || "Google account details not cached yet";

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                {activeProfile ? (
                  <ProfileAvatar profile={activeProfile} size="md" />
                ) : (
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <UserRound size={18} />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{profileTitle}</div>
                  <div className="truncate text-sm text-muted-foreground">{profileSubtitle}</div>
                </div>
              </div>
              <Button className="shrink-0" icon={<FolderOpen size={16} />} disabled={!hasProfiles} onClick={onStart}>
                Start Workflow
              </Button>
            </div>
          </div>

          <StorageUsagePanel error={storageError} pending={storagePending} summary={storageSummary} onRefresh={onRefreshStorage} />
        </Card>

        <ReadinessPanel hasProfiles={hasProfiles} storageError={storageError} storageSummary={storageSummary} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SafetyList />
        <AboutCard />
      </div>
    </div>
  );
}

function StorageUsagePanel({
  error,
  pending,
  summary,
  onRefresh
}: {
  error: string | null;
  pending: boolean;
  summary: StorageUsageSummary | null;
  onRefresh: () => void;
}) {
  const percentValue = summary?.percentFull ? Number.parseInt(summary.percentFull, 10) : null;
  const progressWidth = percentValue === null || Number.isNaN(percentValue) ? 0 : Math.min(100, Math.max(0, percentValue));

  return (
    <div className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <HardDrive size={16} />
            Google storage
          </div>
          <div className="mt-2 text-4xl font-semibold tracking-normal">
            {summary?.percentFull || (pending ? "Loading..." : "Not loaded")}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {summary?.rawUsage || (error ? "Could not load storage usage." : "Storage usage appears after Google sign-in.")}
          </div>
        </div>
        <Button className="shrink-0" variant="secondary" icon={pending ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} disabled={pending} onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      <div className="mt-5 h-3 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressWidth}%` }} />
      </div>

      {summary?.items.length ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
          {summary.items.map((item) => (
            <div key={item.label} className="rounded-md border border-border px-3 py-2 text-sm">
              <div className="text-xs text-muted-foreground">{item.label}</div>
              <div className="mt-1 font-medium">{item.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {error && <div className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{error}</div>}
      {summary && (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 size={13} />
          Updated {new Date(summary.fetchedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

function ReadinessPanel({
  hasProfiles,
  storageError,
  storageSummary
}: {
  hasProfiles: boolean;
  storageError: string | null;
  storageSummary: StorageUsageSummary | null;
}) {
  const rows = [
    {
      label: "Google profile",
      value: hasProfiles ? "Ready" : "Required",
      ok: hasProfiles
    },
    {
      label: "Storage check",
      value: storageSummary ? "Loaded" : storageError ? "Needs attention" : "Pending",
      ok: Boolean(storageSummary)
    },
    {
      label: "Local workflow",
      value: hasProfiles ? "Available" : "Waiting",
      ok: hasProfiles
    }
  ];

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Database size={16} />
        Status
      </div>
      <div className="mt-4 space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              {row.ok ? <Check className="shrink-0 text-primary" size={15} /> : <AlertCircle className="shrink-0 text-muted-foreground" size={15} />}
              <span className="truncate text-muted-foreground">{row.label}</span>
            </div>
            <span className="shrink-0 font-medium">{row.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SafetyList() {
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold">Session safeguards</div>
      <div className="mt-3 grid gap-3 text-sm leading-6 text-muted-foreground md:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
        <div>Manual Google prompts remain under your control.</div>
        <div>Browser cookies stay in the local Electron profile.</div>
        <div>No backend service receives your photos or account data.</div>
      </div>
    </Card>
  );
}

function AboutCard() {
  return (
    <Card className="space-y-3 p-4 text-sm leading-6">
      <div>
        <div className="font-semibold">PhotoDrain</div>
        <p className="mt-1 text-muted-foreground">Local desktop workspace for Google Photos backup and cleanup.</p>
      </div>
      <div>
        <div className="font-medium">Built by Mark Anthony Sabandal</div>
        <p className="mt-1 text-muted-foreground">
          Vibe-coded by Mark. Contact: sabmark@gmail.com
        </p>
      </div>
      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Build version {APP_VERSION}
      </div>
    </Card>
  );
}

function DownloadSummary({ state }: { state: AppState }) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm">
        <span className="font-medium">{state.downloadedFiles.length}</span> ZIP file(s), total {formatBytes(state.totalDownloadedBytes)}
      </div>
      <div className="max-h-72 space-y-2 overflow-auto">
        {state.downloadedFiles.length === 0 && <div className="text-sm text-muted-foreground">No validated ZIP files yet.</div>}
        {state.downloadedFiles.map((file) => (
          <div key={file.path} className="rounded-md border border-border px-3 py-2 text-sm">
            <div className="font-medium">{file.filename}</div>
            <div className="break-all text-xs text-muted-foreground">{file.path}</div>
            <div className="text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LogViewer({ logs }: { logs: AutomationLogEntry[] }) {
  return (
    <Card className="mt-4 max-h-[420px] overflow-auto p-3">
      {logs.slice().reverse().map((log) => (
        <div key={log.id} className="border-b border-border py-2 text-xs last:border-0">
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase">{log.level}</span>
            <span className="text-muted-foreground">{new Date(log.timestamp).toLocaleString()}</span>
          </div>
          <div className="mt-1 text-sm">{log.message}</div>
        </div>
      ))}
    </Card>
  );
}
