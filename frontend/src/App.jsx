import { AuthProvider } from "./context/AuthContext.jsx";
import AppRoutes from "./routes/AppRoutes.jsx";
import Atmosphere from "./components/layout/Atmosphere.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { ProductModeProvider } from "./context/ProductModeContext.jsx";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ProductModeProvider>
          <ToastProvider>
            <Atmosphere />
            <AppRoutes />
          </ToastProvider>
        </ProductModeProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
