import type { ExpoConfig } from 'expo/config';

/**
 * AC-17. Dynamic config rather than a static app.json, because one key must
 * differ between development and production and JSON cannot branch.
 *
 * Development talks to the API over plain HTTP on a LAN address
 * (`http://192.168.x.x:3000`), which both platforms block by default. The
 * deployed API is HTTPS, so those exemptions must NOT ship: a release build
 * carrying them would let the app fall back to cleartext against a host that
 * offers TLS, and nothing at runtime would complain.
 *
 * Scope note: **Expo Go ignores both settings.** It is a prebuilt app with its
 * own entitlements and already permits local cleartext, which is why AC-1's
 * "runs in Expo Go" works regardless. These take effect in a development build
 * and in a release build — the latter being exactly the case that must not be
 * permissive.
 */

type Env = { NODE_ENV?: string | undefined };

/** Android cleartext moved out of the config schema and into this plugin. */
export const BUILD_PROPERTIES = 'expo-build-properties';

export function buildConfig(env: Env = process.env): ExpoConfig {
  // Anything that is not explicitly production is development. The safe
  // default is the restrictive one, so a missing or misspelled NODE_ENV can
  // only ever produce a too-strict development build, never a permissive
  // release.
  const isProduction = env.NODE_ENV === 'production';

  return {
    name: 'Expenses Recorder',
    slug: 'expenses-recorder',
    version: '0.1.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    scheme: 'expenses-recorder',
    ios: {
      supportsTablet: true,
      ...(isProduction
        ? {}
        : {
            infoPlist: {
              // NSAllowsLocalNetworking, deliberately NOT
              // NSAllowsArbitraryLoads: this permits cleartext to local
              // network addresses only, so even the development exemption
              // cannot downgrade a request to an arbitrary internet host.
              NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
            },
          }),
    },
    android: {
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: false,
    },
    web: { favicon: './assets/favicon.png' },
    plugins: [
      'expo-router',
      'expo-secure-store',
      ...(isProduction
        ? []
        : [
            [BUILD_PROPERTIES, { android: { usesCleartextTraffic: true } }] as [
              string,
              Record<string, unknown>,
            ],
          ]),
    ],
  };
}

export default (): ExpoConfig => buildConfig();
