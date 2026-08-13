import { useContext } from "react";
import { ProductModeContext } from "../context/ProductModeContext.jsx";

export function useProductMode() {
  const value = useContext(ProductModeContext);
  if (!value) throw new Error("useProductMode must be used inside ProductModeProvider");
  return value;
}
