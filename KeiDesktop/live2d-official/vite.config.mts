import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);


export default defineConfig({

    resolve: {

        extensions: [
            '.ts',
            '.js'
        ],

        alias: {

            '@framework': path.resolve(
                __dirname,
                '../vendor/cubism/Framework/src'
            )
        }
    },


    build: {

        target: 'es2018',

        outDir: path.resolve(
            __dirname,
            '../renderer/dist/live2d'
        ),

        emptyOutDir: true,

        sourcemap: true,


        lib: {

            entry: path.resolve(
                __dirname,
                'src/main.ts'
            ),

            name: 'KeiOfficialLive2D',

            formats: [
                'iife'
            ],

            fileName: () =>
                'kei-live2d.js'
        }
    }
});