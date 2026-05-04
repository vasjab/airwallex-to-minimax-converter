import type { WalletConfig, WalletConfigMap } from "./types";

const STORAGE_KEY = "awx-minimax-wallets-v1";
const PREFS_KEY = "awx-minimax-prefs-v1";

export interface AppPrefs {
  perDay: boolean;
}

export function loadWallets(): WalletConfigMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWallets();
    const parsed = JSON.parse(raw) as WalletConfigMap;
    return parsed && typeof parsed === "object" ? parsed : defaultWallets();
  } catch {
    return defaultWallets();
  }
}

export function saveWallets(wallets: WalletConfigMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
}

export function loadPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { perDay: true };
    const parsed = JSON.parse(raw) as AppPrefs;
    return { perDay: parsed.perDay !== false };
  } catch {
    return { perDay: true };
  }
}

export function savePrefs(prefs: AppPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function defaultWalletForCurrency(currency: string): WalletConfig {
  if (currency === "EUR") {
    return {
      currency: "EUR",
      iban: "NL71AINH2467531516",
      bic: "AIPBNL2AXXX",
      bankName: "Airwallex (Netherlands) B.V.",
      ownerName: "Alpine Nation d.o.o.",
      ownerAddressLine1: "Gabrščkova ulica 24",
      ownerAddressLine2: "1000 Ljubljana",
      ownerCountry: "SI",
      ownerTaxId: "11414928",
    };
  }
  return {
    currency,
    iban: "",
    bic: "",
    bankName: "",
    ownerName: "Alpine Nation d.o.o.",
    ownerAddressLine1: "Gabrščkova ulica 24",
    ownerAddressLine2: "1000 Ljubljana",
    ownerCountry: "SI",
    ownerTaxId: "11414928",
  };
}

function defaultWallets(): WalletConfigMap {
  return { EUR: defaultWalletForCurrency("EUR") };
}
