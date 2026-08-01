import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api, japi } from './api';
import { DEEP_LINK_HOSTNAME } from '../env/env';
import { notify } from '../events/events';
import { ValidationErrorToast } from '../components/toast';
import {
  ProfileInfo,
  patchProfileInfo,
  setProfileInfo,
} from '../events/profile-info';

// Required so that the OAuth redirect dismisses the in-app browser
// session on iOS / Android. Calling this once at module load is the
// pattern documented by Expo.
WebBrowser.maybeCompleteAuthSession();

// The backend's callback returns to the SPA with the result in the query
// string, but the navigation container rewrites the URL (stripping those
// params) as soon as it mounts. Snapshot the query at module load - which
// runs on the fresh page load before navigation mounts - so the return can
// still be read once the Music section mounts.
let _spotifyWebReturnSearch =
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.search
    : '';

export type SpotifyConnectResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; reason?: string };

type PostSpotifyAuthorizeResponse = {
  authorize_url?: string
};

const refetchProfileInfo = async (): Promise<void> => {
  const response = await api<ProfileInfo>('get', '/profile-info');
  if (response.json) {
    setProfileInfo(response.json);
  }
};

/**
 * Starts the "Connect Spotify" OAuth flow.
 *
 * - Native opens the authorize URL in an in-app browser session; the
 *   backend's `/spotify/callback` 302s to the app's universal-link return
 *   URL with the outcome in query params, which we parse here before
 *   refetching `/profile-info`.
 * - Web is a full-page navigation (same reasoning as the Apple web
 *   sign-in): the backend 302s back to the SPA root, and the outcome is
 *   picked up on the next page load via `consumePendingSpotifyConnect()`.
 */
const connectSpotify = async (): Promise<SpotifyConnectResult> => {
  const redirectTarget = Platform.OS === 'web' ? 'web' : 'app';

  const response = await japi<PostSpotifyAuthorizeResponse>(
    'post',
    '/spotify/authorize',
    { redirect_target: redirectTarget },
  );

  const authorizeUrl = response.json?.authorize_url;
  if (!response.ok || !authorizeUrl) {
    return {
      ok: false,
      cancelled: false,
      reason: 'Couldn’t reach Spotify. Try again later.',
    };
  }

  if (Platform.OS === 'web') {
    // The page is navigating away, so this promise normally never settles —
    // except when the user backs out of the consent screen and the browser
    // restores this page from the back/forward cache, which fires
    // `pageshow`. Resolving as cancelled there un-sticks the button's
    // loading state.
    return new Promise<SpotifyConnectResult>((resolve) => {
      window.addEventListener(
        'pageshow',
        () => resolve({ ok: false, cancelled: true }),
        { once: true },
      );
      window.location.assign(authorizeUrl);
    });
  }

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(
      authorizeUrl,
      `https://${DEEP_LINK_HOSTNAME}/`,
    );
  } catch {
    return { ok: false, cancelled: false, reason: 'Spotify connect failed' };
  }

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { ok: false, cancelled: true };
  }
  if (result.type !== 'success') {
    return { ok: false, cancelled: false, reason: 'Spotify connect failed' };
  }

  const params = _parseQueryParams(result.url);
  const error = params.get('spotify_error');
  if (error) {
    return { ok: false, cancelled: false, reason: `Spotify: ${error}` };
  }
  if (params.get('spotify') !== 'connected') {
    return { ok: false, cancelled: false, reason: 'Spotify connect failed' };
  }

  await refetchProfileInfo();

  return { ok: true };
};

/**
 * On web, completes the connect flow started by `connectSpotify()`.
 *
 * If the URL contains `spotify` / `spotify_error` params, strips them via
 * `history.replaceState` and returns the outcome for a toast. Returns null
 * when there's no pending return. `/profile-info` is fetched fresh on mount
 * anyway, so no refetch is needed here.
 */
const _consumePendingSpotifyConnect = (): SpotifyConnectResult | null => {
  if (Platform.OS !== 'web') return null;
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(_spotifyWebReturnSearch);
  const connected = params.get('spotify');
  const error = params.get('spotify_error');
  if (!connected && !error) return null;
  _spotifyWebReturnSearch = '';

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('spotify');
    url.searchParams.delete('spotify_error');
    const cleanSearch = url.searchParams.toString();
    window.history.replaceState(
      null,
      '',
      url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + url.hash,
    );
  } catch {}

  if (error) {
    return { ok: false, cancelled: false, reason: `Spotify: ${error}` };
  }
  return { ok: true };
};

/**
 * Shows a toast for a failed web connect flow. Called from the app root
 * once the toast host is mounted, so the outcome isn't lost when the user
 * doesn't visit the profile tab after the redirect back.
 */
const showPendingSpotifyConnectToast = (): void => {
  const pending = _consumePendingSpotifyConnect();
  if (!pending || pending.ok || !pending.reason) {
    return;
  }
  const reason = pending.reason;
  notify<React.FC>('toast', () => <ValidationErrorToast error={reason} />);
};

const disconnectSpotify = async (): Promise<boolean> => {
  const response = await japi('post', '/disconnect-spotify');
  if (response.ok) {
    patchProfileInfo({ spotify_artists: [], spotify_connected: false });
  }
  return response.ok;
};

const _parseQueryParams = (url: string): URLSearchParams => {
  // Some browsers/env may not populate URL.searchParams from a relative-ish
  // string; parse the query manually as a fallback.
  try {
    return new URL(url).searchParams;
  } catch {
    const q = url.split('?')[1] ?? '';
    return new URLSearchParams(q.split('#')[0]);
  }
};

export {
  connectSpotify,
  disconnectSpotify,
  showPendingSpotifyConnectToast,
};
