$env:FILTER_BRANCH_SQUELCH_WARNING=1
$filter = '
if [ "$GIT_AUTHOR_EMAIL" = "llosso.mmarco@gmail.com" ]; then
    export GIT_AUTHOR_EMAIL="171587278+LossoMarco@users.noreply.github.com"
fi
if [ "$GIT_COMMITTER_EMAIL" = "llosso.mmarco@gmail.com" ]; then
    export GIT_COMMITTER_EMAIL="171587278+LossoMarco@users.noreply.github.com"
fi
'
git filter-branch -f --env-filter $filter --tag-name-filter cat -- --branches --tags