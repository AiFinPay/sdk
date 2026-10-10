import {
  deriveWallet as derivePackageWallet,
  newWallet as createPackageWallet,
} from "@aifinpay/wallet";
import type { DerivedWallet } from "@aifinpay/wallet";

export type { DerivedWallet } from "@aifinpay/wallet";

export function deriveWallet(seedHex: string): DerivedWallet {
  return derivePackageWallet(seedHex, { mode: "legacy-solana" });
}

export function newWallet(): Promise<DerivedWallet> {
  return createPackageWallet({ mode: "legacy-solana" });
}
