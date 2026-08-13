import { createContext } from "react";

export const ProductModeContext = createContext(null);

export function ProductModeProvider({ children }) {
  return <ProductModeContext.Provider value={{ mode: "simple", isDeveloperMode: false, enableDeveloperMode() {}, enableSimpleMode() {}, toggleProductMode() {} }}>{children}</ProductModeContext.Provider>;
}
