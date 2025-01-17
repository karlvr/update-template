# 📠 Update Template

If you've created a repository using a template (see [Creating a repository from a template](https://docs.github.com/en/github/creating-cloning-and-archiving-repositories/creating-a-repository-from-a-template) on GitHub), it can be hard to "update" the template when new features are added, since it's not a fork. This package fixes that.

## ⭐ Get started

### Using a template

If your template is a git repository, you can install or update it using the URL of the original template repo:

```bash
npx update-template https://github.com/user/repo
```

Or if your repo is based on a template in a local directory:

```bash
npx update-template ./templates/my-template
```

You can also specify multiple templates, and they will be applied sequentially.

```bash
npx update-template ./templates/my-template1 ./templates/my-template2
```

A `.update-template-changes.json` file will be created to store the changes that have been made by the
template(s), so that when you re-run `update-template` any files or dependencies etc added by the template
that are no longer in the template will be removed.

You can add a `-a` option before the template paths to add the listed templates to the existing templates (rather than replacing).
Or you can add a `-d` option before the template paths to remove the listed templates.

### Creating a template

If you're building a template repository, add `update-template` as a dependency:

```bash
npm install @cactuslab/update-template
```

Then, create a `.templaterc.json` file with a list of files you'd like to overwrite:

```json
{
  "files": ["src/**/*.js"]
}
```

Lastly, add an update script to your `package.json` with the URL of your repository:

```json
{
  "scripts": {
    "update-template": "update-template"
  }
}
```

When users want to update your template, they can run `npm run update-template`

If you want to sync your `package.json` (without changing keys like the package name), you can add any of the following
keys to sync the corresponding parts of `package.json`:

```json
{
  "package": {
    "engines": true,
		"dependencies": true,
		"devDependencies": true,
		"optionalDependencies": true,
		"peerDependencies": true,
		"scripts": true
  }
}
```

## 👩‍💻 Development

Build TypeScript:

```bash
npm run build
```

## 📄 License

[MIT](./LICENSE) © [Koj](https://koj.co)

<p align="center">
  <a href="https://koj.co">
    <img width="44" alt="Koj" src="https://kojcdn.com/v1598284251/website-v2/koj-github-footer_m089ze.svg">
  </a>
</p>
<p align="center">
  <sub>An open source project by <a href="https://koj.co">Koj</a>. <br> <a href="https://koj.co">Furnish your home in style, for as low as CHF175/month →</a></sub>
</p>
