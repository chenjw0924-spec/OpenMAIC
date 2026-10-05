'use client';

import { useState, useCallback, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { UsageDashboard } from './usage-dashboard';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, AlertTriangle, Download, ShieldCheck, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  clearLocalCache,
  clearLocalStorageKeepingImportState,
} from '@/lib/device-storage/clear-local-cache';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { runClearCache } from './clear-cache-workflow';

const log = createLogger('GeneralSettings');

/**
 * The shape of a zustand `persist` API this file needs. Declared structurally
 * so one helper covers both stores without importing either state type.
 */
interface PersistApi {
  getOptions: () => {
    name?: string;
    storage?: { removeItem: (name: string) => unknown };
  };
}

/**
 * Clear a store that persists through the KVStore.
 *
 * Not `persist.clearStorage()`: that discards the promise our KV-backed storage
 * returns, and clearing has to be awaited before the reload below.
 */
async function clearPersistedStore(persistApi: PersistApi, fallbackName: string): Promise<void> {
  const { storage, name } = persistApi.getOptions();
  await storage?.removeItem(name ?? fallbackName);
}

export function GeneralSettings() {
  const { t } = useI18n();
  const [signedIn, setSignedIn] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    void fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ user?: unknown }>)
      .then((data) => setSignedIn(Boolean(data.user)))
      .catch(() => setSignedIn(false));
  }, []);

  const exportAccount = useCallback(async () => {
    setAccountBusy(true);
    try {
      const response = await fetch('/api/account/export', { cache: 'no-store' });
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'kestack-account-export.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      log.error('Failed to export account data:', error);
      toast.error('导出失败，请稍后重试');
    } finally {
      setAccountBusy(false);
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    if (window.prompt('删除账号将永久清除服务器数据。请输入 DELETE 确认：') !== 'DELETE') return;
    setAccountBusy(true);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      if (!response.ok) throw new Error('delete failed');
      window.location.assign('/login?deleted=1');
    } catch (error) {
      log.error('Failed to delete account:', error);
      toast.error('账号删除失败，请稍后重试');
      setAccountBusy(false);
    }
  }, []);

  // Clear cache state
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const confirmPhrase = t('settings.clearCacheConfirmPhrase');
  const isConfirmValid = confirmInput === confirmPhrase;

  const handleClearCache = useCallback(async () => {
    if (!isConfirmValid) return;
    setClearing(true);
    try {
      await runClearCache({
        clearLocalCache,
        clearLocalStorage: () => clearLocalStorageKeepingImportState(),
        clearSessionStorage: () => sessionStorage.clear(),
        clearPersistedStores: async () => {
          // The blanket clear only reaches these stores while their KV backend
          // happens to use localStorage. Account-scoped storage needs explicit cleanup.
          await Promise.all([
            clearPersistedStore(useSettingsStore.persist, 'settings-storage'),
            clearPersistedStore(useUserProfileStore.persist, 'user-profile-storage'),
          ]);
        },
      });
      toast.success(t('settings.clearCacheSuccess'));

      // Reload without waiting. The stores are still live in memory, so the
      // longer this page stays up the more chances a `set()` has to persist
      // something after the clear. The seam refuses writes for the duration of
      // a clear, which covers writes issued while the deletes are in flight,
      // but not ones issued after they complete — hence keeping the window
      // short as well.
      window.location.reload();
    } catch (error) {
      log.error('Failed to clear cache:', error);
      toast.error(t('settings.clearCacheFailed'));
      setClearing(false);
    }
  }, [isConfirmValid, t]);

  const clearCacheItems =
    t('settings.clearCacheConfirmItems').split('、').length > 1
      ? t('settings.clearCacheConfirmItems').split('、')
      : t('settings.clearCacheConfirmItems').split(', ');

  return (
    <div className="flex flex-col gap-8">
      {signedIn && (
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 text-primary" />
            <div>
              <h3 className="text-sm font-semibold">隐私与数据控制</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                你可以下载账号数据，或永久删除账号及其服务器数据。浏览器缓存和偏好设置需要单独清除。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={accountBusy}
              onClick={() => void exportAccount()}
            >
              <Download className="mr-1.5 size-3.5" />
              导出我的数据
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={accountBusy}
              onClick={() => void deleteAccount()}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              删除账号和数据
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href="/privacy" target="_blank" rel="noreferrer">
                隐私政策 <ExternalLink className="ml-1 size-3" />
              </a>
            </Button>
          </div>
        </section>
      )}

      {/* Usage statistics dashboard */}
      <UsageDashboard />

      {/* Danger Zone - Clear Cache */}
      <div className="relative rounded-xl border border-destructive/30 bg-destructive/[0.03] dark:bg-destructive/[0.06] overflow-hidden">
        {/* Subtle diagonal stripe pattern for danger emphasis */}
        <div
          className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              transparent,
              transparent 10px,
              currentColor 10px,
              currentColor 11px
            )`,
          }}
        />

        <div className="relative p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-destructive">{t('settings.dangerZone')}</h3>
          </div>

          {/* Content */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{t('settings.clearCache')}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t('settings.clearCacheDescription')}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setConfirmInput('');
                setShowClearDialog(true);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.clearCache')}
            </Button>
          </div>
        </div>
      </div>

      {/* Clear Cache Confirmation Dialog */}
      <AlertDialog
        open={showClearDialog}
        onOpenChange={(open) => {
          if (!clearing) {
            setShowClearDialog(open);
            if (!open) setConfirmInput('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('settings.clearCacheConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('settings.clearCacheConfirmDescription')}</p>
                <ul className="space-y-1.5 ml-1">
                  {clearCacheItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive/60 shrink-0" />
                      {item.trim()}
                    </li>
                  ))}
                </ul>
                <div className="pt-1">
                  <Label className="text-xs font-medium text-foreground">
                    {t('settings.clearCacheConfirmInput')}
                  </Label>
                  <Input
                    className="mt-1.5 h-9 text-sm"
                    placeholder={confirmPhrase}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isConfirmValid) {
                        handleClearCache();
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!isConfirmValid || clearing}
              onClick={handleClearCache}
            >
              {clearing ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1.5" />
              )}
              {t('settings.clearCacheButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
