import { BUILD_PROPERTIES, buildConfig } from '../../app.config';

/**
 * AC-17. The criterion nothing else can catch.
 *
 * Development needs cleartext HTTP to reach the API on a LAN address. The
 * deployed API is HTTPS, and a release build carrying the exemption would
 * silently permit a downgrade — no test fails, no warning appears, and the app
 * works either way. So the assertion has to be on the config itself.
 */

/** The android half now lives in an expo-build-properties plugin entry. */
function cleartextPlugin(config: ReturnType<typeof buildConfig>) {
  return config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === BUILD_PROPERTIES,
  ) as [string, { android?: { usesCleartextTraffic?: boolean } }] | undefined;
}

describe('app config', () => {
  it('permits local cleartext in development', () => {
    const config = buildConfig({ NODE_ENV: 'development' });

    expect(cleartextPlugin(config)?.[1].android?.usesCleartextTraffic).toBe(true);
    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
      NSAllowsLocalNetworking: true,
    });
  });

  it('carries no cleartext exemption in production', () => {
    const config = buildConfig({ NODE_ENV: 'production' });

    expect(cleartextPlugin(config)).toBeUndefined();
    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toBeUndefined();
  });

  it('keeps the router and secure-store plugins in every environment', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const config = buildConfig({ NODE_ENV });

      expect(config.plugins).toEqual(
        expect.arrayContaining(['expo-router', 'expo-secure-store']),
      );
    }
  });

  /**
   * The exemption is limited to local networking rather than
   * NSAllowsArbitraryLoads, so even in development it cannot downgrade a
   * request to an arbitrary internet host.
   */
  it('never allows arbitrary loads, in any environment', () => {
    for (const NODE_ENV of ['development', 'production', 'test', undefined]) {
      const ats = buildConfig({ NODE_ENV }).ios?.infoPlist
        ?.NSAppTransportSecurity as Record<string, unknown> | undefined;

      expect(ats?.NSAllowsArbitraryLoads).toBeUndefined();
    }
  });

  /**
   * An unset or misspelled NODE_ENV must not produce a permissive release by
   * accident. Anything that is not exactly "production" is treated as
   * development, so the failure mode is a working dev build — never a
   * permissive one.
   */
  it('treats an unrecognised NODE_ENV as development', () => {
    expect(
      cleartextPlugin(buildConfig({ NODE_ENV: undefined }))?.[1].android
        ?.usesCleartextTraffic,
    ).toBe(true);
    expect(
      cleartextPlugin(buildConfig({ NODE_ENV: 'Production' }))?.[1].android
        ?.usesCleartextTraffic,
    ).toBe(true);
  });
});
