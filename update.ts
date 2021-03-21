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
  const sourcePaths = process.argv.slice(2)
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

  const previousChanges = await loadPreviousChanges();
  workingPackageJson = await undoPreviousPackageChanges(workingPackageJson, previousChanges);

  const changes: Changes = {
    sources: {},
  };

  for (const source of sources) {
    console.log(c.bold.green(`${source.name}`))
    
    const config = source.config;
    const sourceChanges: SourceChanges = {
      files: [],
      package: {},
    };
    changes.sources[source.name] = sourceChanges;

    const previousSourceChanges = previousChanges.sources[source.name];
    delete previousChanges.sources[source.name];
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

    workingPackageJson = applyPackageChanges(workingPackageJson, localPackageJson, templatePackageJson, config, sourceChanges);

    config.removeFiles = config.removeFiles || [];
    config.removeFiles = [...config.removeFiles, ".templaterc.json"];
    const filesToDelete = await fg(config.removeFiles);
    for await (const file of filesToDelete) {
      const path = join(".", file);
      console.log(c.blue.bold(`  Removing: ${path}`));
      await remove(path);
    }
  
    if (source.temporary) {
      await remove(join(".", source.path));
    }
  }

  /* Remove any files from templates no longer used */
  for (const sourcePath of Object.keys(previousChanges.sources)) {
    console.log(c.bold.red(`${sourcePath} (removed template)`))

    const sourceChanges = previousChanges.sources[sourcePath]!;
    for (const file of sourceChanges!.files) {
      const path = join(".", file);
      console.log(c.blue.bold(`  Removing: ${path}`));
      await remove(path);
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

async function cloneRepo(repoUrl: string): Promise<Source | undefined> {
  if (!repoUrl.includes("@") && !repoUrl.includes("//"))
    repoUrl = `https://github.com/${repoUrl}`;

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
  if (!urlOrPath.includes("//")) {
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

  return cloneRepo(urlOrPath)
}

function applyPackageChanges(target: Package, original: Package, template: Package, config: Config, changes: SourceChanges): Package {
  const result: Package = { ...target };
  if (config.package?.engines) {
    changes.package["engines"] = template.engines;
    result.engines = combineRecords(target.engines, template.engines);


    if (!equal(original.engines, result.engines)) {
      console.log(c.cyan.bold(`  Updated: engines`));
    }
  }
  if (config.npmDependencies || config.package?.dependencies) {
    changes.package["dependencies"] = template.dependencies;
    result.dependencies = combineRecords(target.dependencies, template.dependencies);

    if (!equal(original.dependencies, result.dependencies)) {
      console.log(c.cyan.bold(`  Updated: dependencies`));
    }
  }
  if (config.package?.devDependencies) {
    changes.package["devDependencies"] = template.devDependencies;
    result.devDependencies = combineRecords(target.devDependencies, template.devDependencies);

    if (!equal(original.devDependencies, result.devDependencies)) {
      console.log(c.cyan.bold(`  Updated: devDependencies`));
    }
  }
  if (config.package?.optionalDependencies) {
    changes.package["optionalDependencies"] = template.optionalDependencies;
    result.optionalDependencies = combineRecords(target.optionalDependencies, template.optionalDependencies);

    if (!equal(original.optionalDependencies, result.optionalDependencies)) {
      console.log(c.cyan.bold(`  Updated: optionalDependencies`));
    }
  }
  if (config.package?.peerDependencies) {
    changes.package["peerDependencies"] = template.peerDependencies;
    result.peerDependencies = combineRecords(target.peerDependencies, template.peerDependencies);

    if (!equal(original.peerDependencies, result.peerDependencies)) {
      console.log(c.cyan.bold(`  Updated: peerDependencies`));
    }
  }
  if (config.npmScripts || config.package?.scripts) {
    changes.package["scripts"] = template.scripts;
    result.scripts = combineRecords(target.scripts, template.scripts);

    if (!equal(original.scripts, result.scripts)) {
      console.log(c.cyan.bold(`  Updated: scripts`));
    }
  }
  return result;
}

function undoPackageChanges(target: Package, template: Package): Package {
  const result: Package = target;
  if (template.engines) {
    result.engines = removeRecords(target.engines, template.engines);
  }
  if (template.dependencies) {
    result.dependencies = removeRecords(target.dependencies, template.dependencies);
  }
  if (template.devDependencies) {
    result.devDependencies = removeRecords(target.devDependencies, template.devDependencies);
  }
  if (template.optionalDependencies) {
    result.optionalDependencies = removeRecords(target.optionalDependencies, template.optionalDependencies);
  }
  if (template.peerDependencies) {
    result.peerDependencies = removeRecords(target.peerDependencies, template.peerDependencies);
  }
  if (template.scripts) {
    result.scripts = removeRecords(target.scripts, template.scripts);
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

async function undoPreviousPackageChanges(workingPackageJson: Package, previousChanges: Changes): Promise<Package> {
  for (const sourcePath of Object.keys(previousChanges.sources)) {
    const changes = previousChanges.sources[sourcePath]!;
    workingPackageJson = undoPackageChanges(workingPackageJson, changes.package);
  }

  return workingPackageJson;
}
