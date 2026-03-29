import _ from "lodash";
import path from "path";
import { glob } from "glob";
import { CLIError } from "./errors";
import {
  I18nConfig,
  resolveOverriddenLocale,
  BucketItem,
  LocaleDelimiter,
} from "@lingo.dev/_spec";
import { bucketTypeSchema } from "@lingo.dev/_spec";
import Z from "zod";

type BucketConfig = {
  type: Z.infer<typeof bucketTypeSchema>;
  paths: Array<{ pathPattern: string; delimiter?: LocaleDelimiter }>;
  injectLocale?: string[];
  lockedKeys?: string[];
  lockedPatterns?: string[];
  ignoredKeys?: string[];
};

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function getBuckets(i18nConfig: I18nConfig) {
  const result = Object.entries(i18nConfig.buckets).map(
    ([bucketType, bucketEntry]) => {
      const includeItems = bucketEntry.include.map((item) =>
        resolveBucketItem(item),
      );
      const excludeItems = bucketEntry.exclude?.map((item) =>
        resolveBucketItem(item),
      );
      const config: BucketConfig = {
        type: bucketType as Z.infer<typeof bucketTypeSchema>,
        paths: extractPathPatterns(
          i18nConfig.locale.source,
          includeItems,
          excludeItems,
        ),
      };
      if (bucketEntry.injectLocale) {
        config.injectLocale = bucketEntry.injectLocale;
      }
      if (bucketEntry.lockedKeys) {
        config.lockedKeys = bucketEntry.lockedKeys;
      }
      if (bucketEntry.lockedPatterns) {
        config.lockedPatterns = bucketEntry.lockedPatterns;
      }
      if (bucketEntry.ignoredKeys) {
        config.ignoredKeys = bucketEntry.ignoredKeys;
      }
      return config;
    },
  );

  return result;
}

function extractPathPatterns(
  sourceLocale: string,
  include: BucketItem[],
  exclude?: BucketItem[],
) {
  const includedPatterns = include.flatMap((pattern) =>
    expandPlaceholderedGlob(
      pattern.path,
      resolveOverriddenLocale(sourceLocale, pattern.delimiter),
    ).map((pathPattern) => ({
      pathPattern: toPosix(pathPattern), // ✅ FIX APPLIED HERE
      delimiter: pattern.delimiter,
    })),
  );
  const excludedPatterns = exclude?.flatMap((pattern) =>
    expandPlaceholderedGlob(
      pattern.path,
      resolveOverriddenLocale(sourceLocale, pattern.delimiter),
    ).map((pathPattern) => ({
      pathPattern: toPosix(pathPattern), // ✅ FIX APPLIED HERE
      delimiter: pattern.delimiter,
    })),
  );
  const result = _.differenceBy(
    includedPatterns,
    excludedPatterns ?? [],
    (item) => item.pathPattern,
  );
  return result;
}

// Windows path normalization helper function
function normalizePath(filepath: string): string {
  const normalized = path.normalize(filepath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function expandPlaceholderedGlob(
  _pathPattern: string,
  sourceLocale: string,
): string[] {
  const absolutePathPattern = path.resolve(_pathPattern);
  const pathPattern = normalizePath(
    path.relative(process.cwd(), absolutePathPattern),
  );
  if (pathPattern.startsWith("..")) {
    throw new CLIError({
      message: `Invalid path pattern: ${pathPattern}. Path pattern must be within the current working directory.`,
      docUrl: "invalidPathPattern",
    });
  }

  if (pathPattern.includes("**")) {
    throw new CLIError({
      message: `Invalid path pattern: ${pathPattern}. Recursive path patterns are not supported.`,
      docUrl: "invalidPathPattern",
    });
  }

  const pathPatternChunks = pathPattern.split(path.sep);

  const localeSegmentIndexes = pathPatternChunks.reduce(
    (indexes, segment, index) => {
      if (segment.includes("[locale]")) {
        indexes.push(index);
      }
      return indexes;
    },
    [] as number[],
  );

  const sourcePathPattern = pathPattern.replaceAll(/\[locale\]/g, sourceLocale);

  const unixStylePattern = sourcePathPattern.replace(/\\/g, "/");

  const sourcePaths = glob
    .sync(unixStylePattern, {
      follow: true,
      withFileTypes: true,
      windowsPathsNoEscape: true,
    })
    .filter((file) => file.isFile() || file.isSymbolicLink())
    .map((file) => file.fullpath())
    .map((fullpath) => normalizePath(path.relative(process.cwd(), fullpath)));

  const placeholderedPaths = sourcePaths.map((sourcePath) => {
    const normalizedSourcePath = normalizePath(
      sourcePath.replace(/\//g, path.sep),
    );
    const sourcePathChunks = normalizedSourcePath.split(path.sep);
    localeSegmentIndexes.forEach((localeSegmentIndex) => {
      const pathPatternChunk = pathPatternChunks[localeSegmentIndex];
      const sourcePathChunk = sourcePathChunks[localeSegmentIndex];
      const regexp = new RegExp(
        "(" +
          pathPatternChunk
            .replaceAll(".", "\\.")
            .replaceAll("*", ".*")
            .replace("[locale]", `)${sourceLocale}(`) +
          ")",
      );
      const match = sourcePathChunk.match(regexp);
      if (match) {
        const [, prefix, suffix] = match;
        const placeholderedSegment = prefix + "[locale]" + suffix;
        sourcePathChunks[localeSegmentIndex] = placeholderedSegment;
      }
    });
    return sourcePathChunks.join(path.sep);
  });

  return placeholderedPaths;
}

function resolveBucketItem(bucketItem: string | BucketItem): BucketItem {
  if (typeof bucketItem === "string") {
    return { path: bucketItem, delimiter: null };
  }
  return bucketItem;
}
