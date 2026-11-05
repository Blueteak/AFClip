const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

// Keep release presentation consistent for workflow and manual publication.
const [versionArg, target = 'HEAD', previousArg] = process.argv.slice(2);
const version = (versionArg || require('../package.json').version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-nightly\.[\d.]+)?$/.test(version)) throw new Error('Invalid release version');
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
const sha = git('rev-parse', '--verify', `${target}^{commit}`);
let previous = previousArg;
if (!previous) {
  const tags = git('tag', '--list', 'v[0-9]*', '--sort=-version:refname').split('\n').filter(Boolean);
  const current = tags.indexOf(`v${version}`);
  previous = tags[current < 0 ? 0 : current + 1] || '';
}
const range = previous ? `${previous}..${sha}` : sha;
const commits = git('log', '--no-merges', '--format=%H%x09%aN%x09%aE%x09%s', range)
  .split('\n').filter(Boolean).map(line => {
    const [hash, author, email, ...subject] = line.split('\t');
    return {hash, author, email, subject:subject.join('\t')};
  });
if (!commits.length) throw new Error('No changes in release range');
const highlightsPath = path.join(__dirname, '..', 'release-notes', `${version}.md`);
const highlights = fs.readFileSync(highlightsPath, 'utf8').trim();
if (!highlights) throw new Error(`Write release highlights in ${highlightsPath}`);
const repo = process.env.GITHUB_REPOSITORY || 'Blueteak/AFClip';
const url = `https://github.com/${repo}`;
const people = new Set(commits.map(c => c.email.toLowerCase()));
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const title = version.includes('-nightly.') ? `AFClip Nightly ${version} (${sha.slice(0,12)})` : `AFClip v${version}`;
const changes = commits.map(c => `* ${c.subject} by ${c.author} in ${url}/commit/${c.hash}`).join('\n');
const fullLink = previous ? `${url}/compare/${previous}...v${version}` : `${url}/commits/v${version}`;
const body = `**v${version}** · ${plural(commits.length,'change')} from ${plural(people.size,'contributor')}\n\n${highlights}\n\n<details>\n<summary>Full changelog</summary>\n\n## What's Changed\n${changes}\n\n**Full Changelog**: ${fullLink}\n\n</details>\n`;
const output = path.join(__dirname, '..', 'build');
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, 'release-notes.md'), body);
fs.writeFileSync(path.join(output, 'release-title.txt'), title);
console.log(title);
