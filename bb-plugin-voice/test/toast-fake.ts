export interface CapturedToast {
  kind: "error" | "success";
  message: string;
  description?: string;
}

export const toasts: CapturedToast[] = [];

export const toast = {
  error(message: string, options?: { description?: string }) {
    toasts.push({ kind: "error", message, description: options?.description });
  },
  success(message: string, options?: { description?: string }) {
    toasts.push({ kind: "success", message, description: options?.description });
  },
};
