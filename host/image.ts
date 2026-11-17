// What a VM is made of, and whether it is older than this desolate. The image is what
// image/provision.sh makes from pins.env and image/locks/; a VM provisioned from other
// inputs runs other tools than this desolate expects. provision.sh writes the fingerprint
// it was given into /opt/desolate/image-info, so every clone of the base carries it.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { RELEASE_DIR } from "./paths.ts";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../../suede.nests/dsl.import.meta.vitest.ts";
import type { releaseWith } from "../.harness/host-image.ts";

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : entry.isFile()
          ? [path.join(dir, entry.name)]
          : [],
    );

/** The image's inputs, as a short hash: provision.sh, pins.env and every lock. */
export const imageFingerprint = (release = RELEASE_DIR): string => {
  const inputs = [
    path.join(release, "image", "provision.sh"),
    path.join(release, "pins.env"),
    ...files(path.join(release, "image", "locks")),
  ]
    .map((file) => path.relative(release, file))
    .sort();
  const hash = createHash("sha256");
  for (const file of inputs)
    hash
      .update(`${file}\0`)
      .update(fs.readFileSync(path.join(release, file)))
      .update("\0");
  return hash.digest("hex").slice(0, 16);
};

declare namespace imageFingerprint {
  type Image = {
    "image/provision.sh": "apt-get install git";
    "pins.env": "NODE=24.1.0";
    "image/locks/apt.lock": "git 1:2.47";
  };
  /** the same inputs, the same fingerprint, whatever else the release holds */
  export type OnlyItsInputs = [
    Expect<
      Invoke<
        typeof imageFingerprint,
        [release: Invoke<typeof releaseWith, [name: "one", files: Image]>]
      >,
      "=",
      "92609fe7b3d94819"
    >,
    Expect<
      Invoke<
        typeof imageFingerprint,
        [
          release: Invoke<
            typeof releaseWith,
            [
              name: "two",
              files: {
                "image/provision.sh": "apt-get install git";
                "pins.env": "NODE=24.1.0";
                "image/locks/apt.lock": "git 1:2.47";
                "README.md": "changed";
                "root/state.ts": "changed";
              },
            ]
          >,
        ]
      >,
      "=",
      "92609fe7b3d94819"
    >,
  ];
  /** a lock that moved is another image: VMs made from the old one are older than this desolate */
  export type LockMoved = Expect<
    Invoke<
      typeof imageFingerprint,
      [
        release: Invoke<
          typeof releaseWith,
          [
            name: "three",
            files: {
              "image/provision.sh": "apt-get install git";
              "pins.env": "NODE=24.1.0";
              "image/locks/apt.lock": "git 1:2.48";
            },
          ]
        >,
      ]
    >,
    "=",
    "73298295f269d129"
  >;
}

/** The fingerprint a VM was provisioned with, from what provision.sh wrote; null when it
 *  says none (a VM provisioned before desolate stamped its images). */
export const stampOf = (imageInfo: string): string | null =>
  /^image=([0-9a-f]{16})$/m.exec(imageInfo)?.[1] ?? null;

declare namespace stampOf {
  /** the image= line of what provision.sh wrote, wherever it is among the others */
  export type Stamps = Table<
    typeof stampOf,
    [
      [
        args: [imageInfo: "built=2026-11-16\nimage=0123456789abcdef\n"],
        expected: "0123456789abcdef",
      ],
      [args: [imageInfo: "built=2026-11-16\n"], expected: null],
      [args: [imageInfo: "image=0123456789ABCDEF\n"], expected: null],
      [args: [imageInfo: "image=0123456789abcdef0\n"], expected: null],
      [args: [imageInfo: "old-image=0123456789abcdef\n"], expected: null],
    ]
  >;
}

/** The code a VM runs from its share of the release: each file's hash, so a VM whose share
 *  is another checkout (moved, or a second clone) is found, not trusted. Paths relative to
 *  the release, sorted. */
export const codeFiles = (release = RELEASE_DIR): string[] =>
  ["root", "shared", "workspace", "git"]
    .filter((dir) => fs.existsSync(path.join(release, dir)))
    .flatMap((dir) => files(path.join(release, dir)))
    .map((file) => path.relative(release, file))
    .filter((file) => /\.(ts|sh|py)$/.test(file))
    .sort();

export const sha256 = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** `sha256sum` output for the same files, read in a VM, compared with this release's. The
 *  files that differ, or that the VM does not have. */
export const differing = (sums: string, release = RELEASE_DIR): string[] => {
  const seen = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match) seen.set(match[2]!, match[1]!);
  }
  return codeFiles(release).filter((file) => seen.get(file) !== sha256(path.join(release, file)));
};

declare namespace codeFiles {
  /** the code of the VMs' own directories (not host/, which no VM runs), and not their other files */
  export type VmCode = Expect<
    Invoke<
      typeof codeFiles,
      [
        release: Invoke<
          typeof releaseWith,
          [
            name: "code",
            files: {
              "root/a.ts": "a";
              "shared/b.sh": "b";
              "workspace/c.md": "c";
              "git/d.py": "d";
              "host/e.ts": "e";
            },
          ]
        >,
      ]
    >,
    "=",
    ["git/d.py", "root/a.ts", "shared/b.sh"]
  >;
}

declare namespace differing {
  type Release = Invoke<
    typeof releaseWith,
    [name: "sums", files: { "root/a.ts": "a"; "shared/b.sh": "b"; "git/d.py": "d" }]
  >;
  /** a file whose sum is another, or that the VM has not got, differs; text or binary mode alike */
  export type Differs = Expect<
    Invoke<
      typeof differing,
      [
        sums: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  root/a.ts\n0000000000000000000000000000000000000000000000000000000000000000  shared/b.sh\n18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4 *git/d.py\n",
        release: Release,
      ]
    >,
    "=",
    ["shared/b.sh"]
  >;
  /** a VM that said nothing (or not sha256sum's lines) has none of them */
  export type SaidNothing = Expect<
    Invoke<typeof differing, [sums: "sha256sum: command not found", release: Release]>,
    "=",
    ["git/d.py", "root/a.ts", "shared/b.sh"]
  >;
  /** what the VM has besides is not this release's code, and not looked at */
  export type Extra = Expect<
    Invoke<
      typeof differing,
      [
        sums: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  root/a.ts\nca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  root/planted.ts\n18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4  git/d.py\n3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  shared/b.sh\n",
        release: Release,
      ]
    >,
    "=",
    []
  >;
}
