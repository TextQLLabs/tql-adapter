import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'

/** @type {import('./index.js').default} */
export default function (options = {}) {
    return {
        name: '@sveltejs/adapter-cloudflare',
        async adapt(builder) {
            const files = fileURLToPath(new URL('./files', import.meta.url).href);
            const dest = builder.getBuildDirectory('cloudflare');
            const tmp = builder.getBuildDirectory('cloudflare-tmp');

            builder.rimraf(dest);
            builder.rimraf(tmp);
            builder.mkdirp(tmp);

            // generate 404.html first which can then be overridden by prerendering, if the user defined such a page
            await builder.generateFallback(path.join(dest, '404.html'));

            const dest_dir = `${dest}${builder.config.kit.paths.base}`;
            const written_files = builder.writeClient(dest_dir);
            builder.writePrerendered(dest_dir);

            const relativePath = path.posix.relative(tmp, builder.getServerDirectory());

            writeFileSync(
                `${tmp}/manifest.js`,
                `export const manifest = ${builder.generateManifest({ relativePath })};\n\n` +
                `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n`
            );

            writeFileSync(
                `${dest}/_routes.json`,
                JSON.stringify(get_routes_json(builder, written_files, options.routes ?? {}), null, '\t')
            );

            writeFileSync(`${dest}/_headers`, generate_headers(builder.getAppPath()), { flag: 'a' });

            builder.copy(`${files}/worker.js`, `${tmp}/_worker.js`, {
                replace: {
                    SERVER: `${relativePath}/index.js`,
                    MANIFEST: './manifest.js'
                }
            });

            await esbuild.build({
                plugins: [NodeModulesPolyfillPlugin(), NodeGlobalsPolyfillPlugin({
                    buffer: true,
                    process: true,
                })],
                platform: 'browser',
                conditions: ['worker', 'browser'],
                sourcemap: 'linked',
                target: 'es2022',
                entryPoints: [`${tmp}/_worker.js`],
                outfile: `${dest}/_worker.js`,
                allowOverwrite: true,
                format: 'esm',
                bundle: true,
                loader: {
                    '.wasm': 'copy'
                },
                external: ['cloudflare:*', 'node:*']
            });
        }
    };
}

/**
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {string[]} assets
 * @param {import('./index.js').AdapterOptions['routes']} routes
 * @returns {import('./index.js').RoutesJSONSpec}
 */
function get_routes_json(builder, assets, { include = ['/*'], exclude = ['<all>'] }) {
    if (!Array.isArray(include) || !Array.isArray(exclude)) {
        throw new Error('routes.include and routes.exclude must be arrays');
    }

    if (include.length === 0) {
        throw new Error('routes.include must contain at least one route');
    }

    if (include.length > 100) {
        throw new Error('routes.include must contain 100 or fewer routes');
    }

    exclude = exclude
        .flatMap((rule) => (rule === '<all>' ? ['<build>', '<files>', '<prerendered>'] : rule))
        .flatMap((rule) => {
            if (rule === '<build>') {
                return `/${builder.getAppPath()}/*`;
            }

            if (rule === '<files>') {
                return assets
                    .filter(
                        (file) =>
                            !(
                                file.startsWith(`${builder.config.kit.appDir}/`) ||
                                file === '_headers' ||
                                file === '_redirects'
                            )
                    )
                    .map((file) => `/${file}`);
            }

            if (rule === '<prerendered>') {
                const prerendered = [];
                for (const path of builder.prerendered.paths) {
                    if (!builder.prerendered.redirects.has(path)) {
                        prerendered.push(path);
                    }
                }

                return prerendered;
            }

            return rule;
        });

    const excess = include.length + exclude.length - 100;
    if (excess > 0) {
        const message = `Function includes/excludes exceeds _routes.json limits (see https://developers.cloudflare.com/pages/platform/functions/routing/#limits). Dropping ${excess} exclude rules — this will cause unnecessary function invocations.`;
        builder.log.warn(message);

        exclude.length -= excess;
    }

    return {
        version: 1,
        description: 'Generated by @sveltejs/adapter-cloudflare',
        include,
        exclude
    };
}

/** @param {string} app_dir */
function generate_headers(app_dir) {
    return `
# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
/${app_dir}/*
  X-Robots-Tag: noindex
	Cache-Control: no-cache
/${app_dir}/immutable/*
  ! Cache-Control
	Cache-Control: public, immutable, max-age=31536000
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
`.trimEnd();
}