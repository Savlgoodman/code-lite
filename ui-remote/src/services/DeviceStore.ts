/**
 * DeviceStore — 多设备持久化存储
 *
 * 职责:
 * - 存储/读取设备列表（Capacitor Preferences + localStorage）
 * - 追踪当前活跃设备
 * - 从 legacy 单配置 keys 自动迁移
 */

import { Preferences } from "@capacitor/preferences";

const DEVICE_LIST_KEY = "code-lite-device-list";
const ACTIVE_DEVICE_ID_KEY = "code-lite-active-device-id";
const LS_DEVICE_LIST = "code-lite-device-list";
const LS_ACTIVE_DEVICE_ID = "code-lite-active-device-id";

// Legacy keys (backward compat)
const LS_RELAY_URL = "code-lite-relay-url";
const LS_PAIR_KEY = "code-lite-pair-key";
const LS_DEVICE_NAME = "code-lite-device-name";

export interface DeviceRecord {
  id: string;
  name: string;
  relayUrl: string;
  pairKey: string;
  online: boolean;
  lastSeen: number;
}

export class DeviceStore {
  async loadAll(): Promise<DeviceRecord[]> {
    // Capacitor Preferences
    const prefResult = await Preferences.get({ key: DEVICE_LIST_KEY });
    if (prefResult.value) {
      try {
        return JSON.parse(prefResult.value) as DeviceRecord[];
      } catch {
        // corrupt data, fall through
      }
    }

    // localStorage fallback
    const ls = localStorage.getItem(LS_DEVICE_LIST);
    if (ls) {
      try {
        return JSON.parse(ls) as DeviceRecord[];
      } catch {
        return [];
      }
    }

    return [];
  }

  async saveAll(devices: DeviceRecord[]): Promise<void> {
    const json = JSON.stringify(devices);
    await Preferences.set({ key: DEVICE_LIST_KEY, value: json });
    localStorage.setItem(LS_DEVICE_LIST, json);
  }

  async saveDevice(device: DeviceRecord): Promise<void> {
    const devices = await this.loadAll();
    const idx = devices.findIndex((d) => d.id === device.id);
    if (idx >= 0) {
      devices[idx] = device;
    } else {
      devices.push(device);
    }
    await this.saveAll(devices);
  }

  async removeDevice(id: string): Promise<void> {
    const devices = (await this.loadAll()).filter((d) => d.id !== id);
    await this.saveAll(devices);

    // Clear active if removing active device
    const activeId = await this.getActiveDeviceId();
    if (activeId === id) {
      await this.setActiveDeviceId(null);
    }
  }

  async getActiveDeviceId(): Promise<string | null> {
    const prefResult = await Preferences.get({ key: ACTIVE_DEVICE_ID_KEY });
    if (prefResult.value) return prefResult.value;

    const ls = localStorage.getItem(LS_ACTIVE_DEVICE_ID);
    if (ls) return ls;

    return null;
  }

  async setActiveDeviceId(id: string | null): Promise<void> {
    if (id) {
      await Preferences.set({ key: ACTIVE_DEVICE_ID_KEY, value: id });
      localStorage.setItem(LS_ACTIVE_DEVICE_ID, id);
    } else {
      await Preferences.remove({ key: ACTIVE_DEVICE_ID_KEY });
      localStorage.removeItem(LS_ACTIVE_DEVICE_ID);
    }
  }

  async getActiveDevice(): Promise<DeviceRecord | null> {
    const id = await this.getActiveDeviceId();
    if (!id) return null;
    const devices = await this.loadAll();
    return devices.find((d) => d.id === id) ?? null;
  }

  async updateDeviceOnline(id: string, online: boolean): Promise<void> {
    const devices = await this.loadAll();
    const device = devices.find((d) => d.id === id);
    if (device) {
      device.online = online;
      device.lastSeen = Date.now();
      await this.saveAll(devices);
    }
  }

  /** 从 legacy 单配置 keys 迁移（首次加载时调用） */
  async migrate(): Promise<void> {
    const devices = await this.loadAll();
    if (devices.length > 0) return; // already has devices

    const lsUrl = localStorage.getItem(LS_RELAY_URL);
    const lsKey = localStorage.getItem(LS_PAIR_KEY);
    const lsName = localStorage.getItem(LS_DEVICE_NAME);

    if (!lsUrl || !lsKey) return; // no legacy data

    const device: DeviceRecord = {
      id: crypto.randomUUID(),
      name: lsName || "我的设备",
      relayUrl: lsUrl,
      pairKey: lsKey,
      online: false,
      lastSeen: Date.now(),
    };

    await this.saveDevice(device);
    await this.setActiveDeviceId(device.id);
  }
}

export const deviceStore = new DeviceStore();
