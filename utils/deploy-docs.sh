#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'


# move to the build dir..
cd $TRAVIS_BUILD_DIR

# install apidocs
npm install -g apidoc@0.16.1

# deploy!

# checkout gh-pages branch
git fetch
git checkout gh-pages

# run apidoc
apidoc -i . -f js -e node_modules

# delete everything except for the doc folder
find . ! \( -path './.git' -prune \) ! \( -path './doc' -prune \) ! -name '.' ! -name '..' -print0 |  xargs -0 rm -rf --

# move content of doc to .
mv doc/* .

# delete doc folder
rm -rf doc

# add everything
git add -A

# tell git who you are
git config user.name "Travis-CI"
git config user.email "travis@travis-ci.org"

# commit
git commit -m "Deployed by Travis"

# push to github!
git push "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" gh-pages
