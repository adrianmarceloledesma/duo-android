import 'fast-text-encoding';
import { fromByteArray } from 'base64-js';
import { CryptoDigestAlgorithm, digest, getRandomValues } from 'expo-crypto';
import { openAuthSessionAsync } from 'expo-web-browser';
import type { SupabaseClient } from '@supabase/supabase-js';

const redirectTo = 'com.duo.publicdemo://auth/callback';

function enablePkceCrypto() {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  }
  const crypto = globalThis.crypto;
  if (typeof crypto.getRandomValues !== 'function') {
    Object.defineProperty(crypto, 'getRandomValues', { value: getRandomValues, configurable: true });
  }
  if (!crypto.subtle) {
    // The Supabase PKCE client uses SHA-256 on runtimes without Web Crypto.
    Object.defineProperty(crypto, 'subtle', {
      value: {
        async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
          if (name !== 'SHA-256') throw new Error('Unsupported digest algorithm');
          return digest(CryptoDigestAlgorithm.SHA256, data);
        },
      },
      configurable: true,
    });
  }
  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = value => fromByteArray(Uint8Array.from(value.split(''), character => {
      const byte = character.charCodeAt(0);
      if (byte > 255) throw new DOMException('Expected Latin-1 input', 'InvalidCharacterError');
      return byte;
    }));
  }
}

export async function completeGoogleSignIn(client: SupabaseClient, url: string) {
  if (url.split(/[?#]/, 1)[0] !== redirectTo) return false;
  const callback = new URL(url);
  const fragment = new URLSearchParams(callback.hash.slice(1));
  const error = callback.searchParams.get('error') ?? fragment.get('error');
  if (error) throw { code: 'google_account_unavailable' };

  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw { code: 'google_callback_invalid' };
  const exchange = await client.auth.exchangeCodeForSession(codes[0]);
  if (exchange.error) throw exchange.error;
  return true;
}

export async function signInWithGoogle(client: SupabaseClient) {
  enablePkceCrypto();
  if (typeof TextEncoder !== 'function' || typeof btoa !== 'function') {
    throw { code: 'google_unavailable' };
  }
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
  if (!data.url || new URL(data.url).searchParams.get('code_challenge_method')?.toLowerCase() !== 's256') {
    throw { code: 'google_unavailable' };
  }

  const result = await openAuthSessionAsync(data.url, redirectTo);
  if (result.type === 'success' && !(await completeGoogleSignIn(client, result.url))) {
    throw { code: 'google_callback_invalid' };
  }
}

