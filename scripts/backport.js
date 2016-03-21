// Description:
//   Backport a pull request to specific branches
//
// Commands:
//   jasper backport <pr-url> <branches> - Backport the given PR to the space-separated branches

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const { homedir } = require('os');

const { includes } = require('lodash');
const { join, resolve } = require('path');
const { promisify } = require('bluebird');
const request = require('request');
const tmp = require('tmp');

const { createIssue, createPullRequest, getCommits, getInfo } = require('../src/github');
const { openOrClone, getSignature } = require('../src/git');

const BACKPORT_REGEX = /backport (\S+) ((?:\S *)+)/;
const PR_URL_REGEX = /^https\:\/\/github.com\/([^\/]+\/[^\/]+)\/pull\/(\d+)$/;
const CONFLICTS_REGEX = /applied patch to \'.+\' with conflicts/i;

const requestGet = promisify(request.get);
const tmpFile = promisify(tmp.file, { multiArgs: true });
const writeFile = promisify(fs.writeFile);

module.exports = robot => {
  robot.respond(BACKPORT_REGEX, res => {
    const { github } = robot;

    const [ _cmd, url, allBranches ] = res.match;
    const branches = allBranches.split(/\s+/);

    const [ _url, repo, number ] = url.match(PR_URL_REGEX);

    const githubRepo = github.repo(repo);
    const pr = github.pr(repo, number);

    Promise.all([
      getInfo(pr),
      getCommits(pr)
    ])
    .then(([ info, commits ]) => {
      const target = info.base.ref;
      if (includes(branches, target)) {
        throw new Error('Cannot backport into original PR target branch');
      }

      const { merged } = info;
      if (!merged) {
        throw new Error('Cannot backport unmerged pull requests');
      }

      const original = info.head.ref;

      let num = 0;
      const baseCommitMessage = commits.map(data => {
        const { commit, sha } = data;
        const { author, committer, message } = commit;

        num++;

        const msg = [
          `[Commit ${num}]`,
          `${message}\n`,
          `Original sha: ${sha}`,
          `Authored by ${author.name} <${author.email}> on ${author.date}`,
          `Committed by ${committer.name} <${committer.email}> on ${committer.date}`
        ];

        return msg.join('\n'); // between lines of an individual message
      }).join('\n\n'); // between messages

      let cleanupTmp = () => {};
      const diffFile = requestGet(info.diff_url)
        .then(res => res.body)
        .then(diff => {
          return tmpFile({ prefix: 'jasper-' }).then(([ path, fd, cleanup ]) => {
            cleanupTmp = cleanup;
            return writeFile(path, diff).then(() => path);
          });
        });

      function backportBranchName(target) {
        return `jasper/backport/${number}-${target}-${original}`;
      }

      const { Cred } = require('nodegit');
      const fetchOpts = {
        callbacks: {
          credentials(url, userName) {
            return Cred.sshKeyNew(
              userName,
              join(homedir(), '.ssh', 'jasper_id_rsa.pub'),
              join(homedir(), '.ssh', 'jasper_id_rsa'),
              ''
            );
          },
          certificateCheck() {
            return 1;
          }
        }
      };

      const branchesWithConflicts = [];

      const repoDir = resolve(__dirname, '..', 'repos', repo);
      return openOrClone(repoDir, info.base.repo.ssh_url, fetchOpts).then(repo => {
        return branches
          .reduce((promise, target) => {
            const backportBranch = backportBranchName(target);

            const commitMessage = `Backport PR #${number} to ${target}\n\n${baseCommitMessage}`;

            let hasConflicts = false;

            return promise
              .then(() => repo.getReferenceCommit(`origin/${target}`))
              .then(commit => repo.createBranch(backportBranch, commit))
              .then(() => repo.checkoutBranch(backportBranch))
              .then(() => diffFile)
              .then(path => {
                return new Promise((resolve, reject) => {
                  const cwd = repoDir;
                  execFile('git', ['apply', '--3way', path], { cwd }, (err) => {
                    if (err) {
                      if (!CONFLICTS_REGEX.test(err.message)) {
                        return reject(err);
                      }
                      branchesWithConflicts.push(target);
                    }
                    resolve();
                  });
                });
              })
              .then(() => repo.index())
              .then(index => {
                return index.addAll('.')
                  .then(() => index.write())
                  .then(() => index.writeTree());
              })
              .then(treeOid => {
                return Promise.all([
                  repo.getHeadCommit(),
                  getSignature()
                ]).then(([parent, signature]) => {
                  return repo.createCommit(
                    'HEAD',
                    signature,
                    signature,
                    commitMessage,
                    treeOid,
                    [parent]
                  );
                });
              });
          }, repo.fetch('origin', fetchOpts))
          .then(() => {
            return repo.getRemote('origin')
              .then(remote => {
                return branches
                  .map(backportBranchName)
                  .map(branch => {
                    const ref = `refs/heads/${branch}`;
                    return [`${ref}:${ref}`];
                  })
                  .reduce((promise, refs) => {
                    return promise.then(() => remote.push(refs, fetchOpts));
                  }, Promise.resolve()); // libgit2 throws if this happens in parallel
              });
          })
          .then(() => {
            return Promise.all(
              branches
                .map(target => {
                  const backportBranch = backportBranchName(target);

                  const params = {
                    title: `[backport] PR #${number} to ${target}`,
                    body: `Backport PR #${number} to ${target}\n\n${baseCommitMessage}`,
                    assignee: info.merged_by.login,
                    labels: [ 'backport' ]
                  };

                  if (includes(branchesWithConflicts, target)) {
                    params.labels.push('has conflicts');
                  }

                  return createIssue(githubRepo, params)
                    .then(issue => {
                      const params = {
                        issue: issue.number,
                        head: backportBranch,
                        base: target
                      };
                      return createPullRequest(githubRepo, params);
                    });
                })
            );
          })
          .then(() => {
            cleanupTmp();
            const allBranches = branches.join(', ');
            res.send(`Backported pull request #${number} to ${allBranches}`);
          })
      });
    })
    .catch(err => robot.emit('error', err));
  });

  // whenever backport PR without conflicts/updates goes green, merge
  robot.router.post('/backport', (req, res) => {
    // do nothing if PR is not in exactly this state:
      // labels: backport, noconflicts
      // green build, green cla
      // original commits?
  });
};
