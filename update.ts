import { execSync } from "child_process";
import { join } from "path";
import fg from "fast-glob";
import { readJson, copyFile, remove, ensureFile, writeFile, stat } from "fs-extra";
import c from 'ansi-colors';
import equal from 'deep-equal';
import { Source, Config, Package, Changes, SourceChanges } from './types';

/** The name of the file in which we store a record of the changes we've made. */
const CHANGES_FILE = ".update-template-changes.json";

export const update = async (): Promise<number> => {
  const previousChanges = await loadPreviousChanges();

  const sourcePaths = findSourcePaths(process.argv.slice(2), previousChanges);
  const sources: Source[] = []

  /* Load sources */
  for (const sourcePath of sourcePaths) {
    try {
      const source = await findTemplateSource(sourcePath)
      if (!source) {
        throw new Error(`Couldn't load source: ${sourcePath}`)
      }
      sources.push(source)
    } catch (error) {
      console.error(c.red.bold(`${sourcePath}: ${error.message}`));
      return 1;
    }
  }

  if (sources.length === 0) {
    throw new Error("Provide source repositories or paths");
  }
  
  const localPackageJson: Package = await readJson(join(".", "package.json"));
  let workingPackageJson: Package = { ...localPackageJson };

  const changes: Changes = {
    sources: {},
  };

  /* Remove any changes from templates no longer used */
  for (const sourceName of Object.keys(previousChanges.sources)) {
    if (!sources.find(s => s.name === sourceName)) {
      console.log(c.red.bold(`${sourceName} (removing template)`));
      
      const previousSourceChanges = previousChanges.sources[sourceName]!;
      workingPackageJson = await undoPreviousTemplateChanges(workingPackageJson, sourceName, previousSourceChanges);
    }
  }

  for (const source of sources) {
    console.log(c.bold.green(`${source.name}`))
    
    const config = source.config;
    const sourceChanges: SourceChanges = {
      files: [],
      package: {},
    };
    changes.sources[source.name] = sourceChanges;

    const previousSourceChanges = previousChanges.sources[source.name];
    const previousFiles = previousSourceChanges ? previousSourceChanges.files : [];

    const files = (
      await fg((config.files || []).map((glob) => `${source.path}/${glob}`))
    ).map((file) => file.substring(source.path.length));
    for await (const file of files) {
      await ensureFile(join(".", file));
      const dest = join(".", file);
      console.log(c.bold.blue(`  Copying: ${dest}`));
      await copyFile(join(".", source.path, file), dest);

      sourceChanges.files.push(file);
      const foundPreviousFile = previousFiles.indexOf(file);
      if (foundPreviousFile !== -1) {
        previousFiles.splice(foundPreviousFile, 1);
      }
    }

    /* Remove defunct files from template */
    if (previousFiles.length > 0) {
      for (const file of previousFiles) {
        const path = join(".", file);
        console.log(c.blue.bold(`  Removing: ${path} (removed from template)`));
        await remove(path);
      }
    }

    const templatePackageJson = await readJson(
      join(".", source.path, "package.json")
    );

    workingPackageJson = applyPackageChanges(workingPackageJson, templatePackageJson, config, previousSourceChanges, sourceChanges);

    config.removeFiles = config.removeFiles || [];
    config.removeFiles = [...config.removeFiles, ".templaterc.json"];
    const filesToDelete = await fg(config.removeFiles);
    for await (const file of filesToDelete) {
      const path = join(".", file);
      console.log(c.blue.bold(`  Removing: ${path}`));
      await remove(path);
    }

    /* Remove any remaining changes, that are no longer made by templates */
    if (previousSourceChanges) {
      workingPackageJson = await undoPreviousTemplateChanges(workingPackageJson, source.name, previousSourceChanges);
    }
  
    if (source.temporary) {
      await remove(join(".", source.path));
    }
  }

  /* Update package.json */
  if (!equal(localPackageJson, workingPackageJson)) {
    await writeFile(
      join(".", "package.json"),
      JSON.stringify(workingPackageJson, null, 2) + "\n"
    );
  }

  /* Write changes file */
  await writeFile(
    join(".", CHANGES_FILE),
    JSON.stringify(changes, null, 2) + "\n"
  );

  return 0;
};

function findSourcePaths(argv: string[], previousChanges: Changes): string[] {
  if (argv.length > 0) {
    return argv;
  }
  return Object.keys(previousChanges.sources);
}

async function cloneRepo(repoUrl: string): Promise<Source | undefined> {
  // If this is running in a Github Actions workflow, we know the repo name
  let [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (owner && repo)
    if (repoUrl === `https://github.com/${owner}/${repo}`) {
      console.log("Skipping updating same repo");
      return undefined
    }

  const tempDir = `tempDir_${Math.random().toString(32).split(".")[1]}`;
  execSync(`git clone ${repoUrl} ${tempDir}`);

  let config: Config = {};
  try {
    config = await readJson(join(".", tempDir, ".templaterc.json"));
  } catch (error) {
    console.log(`${repoUrl}: .templaterc.json config file not found`);
  }

  return {
    name: repoUrl,
    path: tempDir,
    temporary: true,
    config,
  }
}

async function findTemplateSource(urlOrPath: string): Promise<Source | undefined> {
  if (urlOrPath.includes("//")) {
    return cloneRepo(urlOrPath);
  }

  const statResult = await stat(urlOrPath)
  if (statResult.isDirectory()) {
    let config: Config = {};
    try {
      config = await readJson(join(".", urlOrPath, ".templaterc.json"));
    } catch (error) {
      console.log(`${urlOrPath}: .templaterc.json config file not found`);
    }
    
    return {
      name: urlOrPath,
      path: urlOrPath,
      temporary: false,
      config,
    }
  }
}

function applyPackageChanges(target: Package, template: Package, config: Config, previousChanges: SourceChanges | undefined, changes: SourceChanges): Package {
  const result: Package = { ...target };

  function applyObjectChange(key: string) {
    if (!template[key]) {
      console.log(c.yellow.bold(`  Package is missing "${key}"`))
      return
    }
    changes.package[key] = template[key];
    result[key] = combineRecords(target[key], template[key]);

    if (previousChanges && previousChanges.package[key] && template[key]) {
      for (const subkey of Object.keys(template[key])) {
        delete previousChanges.package[key][subkey];
      }
    }

    if (!equal(target[key], result[key])) {
      console.log(c.cyan.bold(`  Updated: ${key}`));
    }
  }

  if (config.package?.engines) {
    applyObjectChange("engines");
  }
  if (config.npmDependencies || config.package?.dependencies) {
    applyObjectChange("dependencies");
  }
  if (config.package?.devDependencies) {
    applyObjectChange("devDependencies");
  }
  if (config.package?.optionalDependencies) {
    applyObjectChange("optionalDependencies");
  }
  if (config.package?.peerDependencies) {
    applyObjectChange("peerDependencies");
  }
  if (config.npmScripts || config.package?.scripts) {
    applyObjectChange("scripts");
  }
  return result;
}

function undoPackageChanges(target: Package, template: Package): Package {
  const result: Package = { ...target };

  function applyObjectChange(key: string) {
    result[key] = removeRecords(target[key], template[key]);

    if (!equal(target[key], result[key])) {
      console.log(c.red.bold(`  Updated: ${key}`));
    }
  }

  if (template.engines) {
    applyObjectChange("engines");
  }
  if (template.dependencies) {
    applyObjectChange("dependencies");
  }
  if (template.devDependencies) {
    applyObjectChange("devDependencies");
  }
  if (template.optionalDependencies) {
    applyObjectChange("optionalDependencies");
  }
  if (template.peerDependencies) {
    applyObjectChange("peerDependencies");
  }
  if (template.scripts) {
    applyObjectChange("scripts");
  }
  return result;
}

function combineRecords(existing: Record<string, string>, template: Record<string, string>): Record<string, string> {
  if (typeof existing !== "object") {
    if (typeof template !== "object") {
      return existing
    } else {
      return template
    }
  }

  const combined = {
    ...existing,
    ...template,
  };
  const ordered: Record<string, string> = {};
  Object.keys(combined)
    .sort()
    .forEach((key) => (ordered[key] = combined[key]));
  return ordered;
}

function removeRecords(existing: Record<string, string>, template: Record<string, string>): Record<string, string> {
  if (typeof existing !== "object" || typeof template !== "object") {
    return existing
  }

  const combined = {
    ...existing,
  };

  for (const key of Object.keys(template)) {
    delete combined[key];
  }
  return combined;
}

async function loadPreviousChanges(): Promise<Changes> {
  try {
    return await readJson(join(".", CHANGES_FILE));
  } catch (error) {
    /* Ignore no previous changes file */
    return {
      sources: {},
    }
  }
}

async function undoPreviousTemplateChanges(workingPackageJson: Package, sourcePath: string,sourceChanges: SourceChanges): Promise<Package> {
  /* Remove any files from templates no longer used */
  for (const file of sourceChanges.files) {
    const path = join(".", file);
    console.log(c.blue.bold(`  Removing: ${path}`));
    await remove(path);
  }

  return undoPackageChanges(workingPackageJson, sourceChanges.package);
}
