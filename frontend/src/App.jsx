import { AuthProvider } from "./context/AuthContext.jsx";
import AppRoutes from "./routes/AppRoutes.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { ProductModeProvider } from "./context/ProductModeContext.jsx";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ProductModeProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </ProductModeProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
