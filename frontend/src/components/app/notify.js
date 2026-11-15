import { toast } from 'sonner';

/** Toast helper: notify.success('Saved'), notify.error(err.message), notify.info('...'). */
export const notify = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
  info: (message) => toast(message),
};
