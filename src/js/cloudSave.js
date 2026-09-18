import store from "../store";
import { decodeFile, getSavefile, saveLocal } from "./savefile";
import { LOCAL_STORAGE_NAME } from "./constants";

const CLOUD_SAVE_URL = "https://gooboo-save.shuai-develop.workers.dev/save";
const CLOUD_TOKEN_STORAGE_NAME = "goobooCloudToken";
const CLOUD_REVISION_STORAGE_NAME = "goobooCloudRevision";
const CLOUD_DEVICE_STORAGE_NAME = "goobooCloudDeviceId";
const CLOUD_SYNC_INTERVAL = 120000;
const CLOUD_REQUEST_TIMEOUT = 8000;

let cloudSyncTimer = null;
let activeSync = null;

export {
    clearCloudToken,
    getCloudToken,
    setCloudToken,
    startCloudSync,
    stopCloudSync,
    syncCloudSave
};

function getCloudToken() {
    return localStorage.getItem(CLOUD_TOKEN_STORAGE_NAME) || "";
}

function setCloudToken(token) {
    localStorage.setItem(CLOUD_TOKEN_STORAGE_NAME, token);
}

function clearCloudToken() {
    localStorage.removeItem(CLOUD_TOKEN_STORAGE_NAME);
    localStorage.removeItem(CLOUD_REVISION_STORAGE_NAME);
}

function getDeviceId() {
    let deviceId = localStorage.getItem(CLOUD_DEVICE_STORAGE_NAME);
    if (!deviceId) {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            deviceId = window.crypto.randomUUID();
        } else {
            deviceId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
        }
        localStorage.setItem(CLOUD_DEVICE_STORAGE_NAME, deviceId);
    }
    return deviceId;
}

function setCloudRevision(revision) {
    localStorage.setItem(CLOUD_REVISION_STORAGE_NAME, String(revision));
}

function getSaveInfo(saveData) {
    return decodeFile(saveData, false);
}

async function cloudRequest(method, body = null) {
    const token = getCloudToken();
    if (!token) {
        throw new Error("Cloud sync token is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLOUD_REQUEST_TIMEOUT);

    try {
        const response = await fetch(CLOUD_SAVE_URL, {
            method,
            headers: {
                "Authorization": `Bearer ${token}`,
                ...(body === null ? {} : {"Content-Type": "application/json"})
            },
            body: body === null ? null : JSON.stringify(body),
            cache: "no-store",
            signal: controller.signal
        });

        let data = null;
        try {
            data = await response.json();
        } catch {
            data = {};
        }

        if (response.status === 401) {
            throw new Error("SYNC_TOKEN 不正确");
        }

        return {response, data};
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("连接云存档超时");
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function getCloudSave() {
    const {response, data} = await cloudRequest("GET");
    if (!response.ok) {
        throw new Error(data.error || `读取云存档失败（HTTP ${response.status}）`);
    }
    return data;
}

async function putCloudSave(saveData, baseRevision) {
    const saveInfo = getSaveInfo(saveData);
    if (!saveInfo) {
        throw new Error("当前本地存档无效");
    }

    const {response, data} = await cloudRequest("PUT", {
        saveData,
        timestamp: saveInfo.timestamp,
        baseRevision,
        deviceId: getDeviceId()
    });

    if (response.status === 409) {
        return {conflict: true, ...data};
    }
    if (!response.ok) {
        throw new Error(data.error || `写入云存档失败（HTTP ${response.status}）`);
    }
    return {conflict: false, ...data};
}

function useCloudSave(cloud) {
    localStorage.setItem(LOCAL_STORAGE_NAME, cloud.saveData);
    setCloudRevision(cloud.revision);
    window.location.reload();
}

async function performSync({interactive = false} = {}) {
    if (!getCloudToken()) {
        return {status: "disabled"};
    }
    if (store.state.system.screen === "tab-duplicate") {
        return {status: "skipped"};
    }

    saveLocal();
    const localSave = getSavefile();
    const localInfo = getSaveInfo(localSave);
    if (!localInfo) {
        throw new Error("无法读取当前本地存档");
    }

    const cloud = await getCloudSave();

    if (!cloud.exists) {
        const uploaded = await putCloudSave(localSave, 0);
        if (uploaded.conflict) {
            return {status: "conflict"};
        }
        setCloudRevision(uploaded.revision);
        return {status: "created", revision: uploaded.revision};
    }

    setCloudRevision(cloud.revision);

    const cloudInfo = getSaveInfo(cloud.saveData);
    if (!cloudInfo) {
        throw new Error("云端存档内容无效");
    }

    if (localInfo.playerId && cloudInfo.playerId && localInfo.playerId !== cloudInfo.playerId) {
        if (interactive) {
            const useCloud = window.confirm(
                "检测到云端存档与当前浏览器不是同一个角色。\n\n" +
                "确定：使用云端存档覆盖当前浏览器本地存档。\n" +
                "取消：不修改任何存档。"
            );
            if (useCloud) {
                useCloudSave(cloud);
                return {status: "downloaded"};
            }
        }
        return {status: "different-save"};
    }

    const localTimestamp = Number(localInfo.timestamp || 0);
    const cloudTimestamp = Number(cloud.timestamp || cloudInfo.timestamp || 0);

    if (cloudTimestamp > localTimestamp) {
        useCloudSave(cloud);
        return {status: "downloaded"};
    }

    if (localTimestamp > cloudTimestamp) {
        const uploaded = await putCloudSave(localSave, cloud.revision);
        if (uploaded.conflict) {
            return {status: "conflict", revision: uploaded.revision};
        }
        setCloudRevision(uploaded.revision);
        return {status: "uploaded", revision: uploaded.revision};
    }

    return {status: "up-to-date", revision: cloud.revision};
}

function syncCloudSave(options = {}) {
    if (activeSync) {
        return activeSync;
    }
    activeSync = performSync(options).finally(() => {
        activeSync = null;
    });
    return activeSync;
}

function startCloudSync(syncImmediately = true) {
    if (!getCloudToken()) {
        return;
    }

    if (cloudSyncTimer === null) {
        cloudSyncTimer = setInterval(() => {
            syncCloudSave().catch(() => {});
        }, CLOUD_SYNC_INTERVAL);
    }

    if (syncImmediately) {
        syncCloudSave().catch(() => {});
    }
}

function stopCloudSync() {
    if (cloudSyncTimer !== null) {
        clearInterval(cloudSyncTimer);
        cloudSyncTimer = null;
    }
}
