# Preview scrolling documentation

The companion public guide change is in `preview-scroll-docs.patch`. Apply it with `git apply --unidiff-zero` to `hibigarden/docs` at revision `5080a602bcec99b8925c21486ae00278bf205985` or a compatible newer revision.

After the docs change is published, update `docs-revision` to that commit and run `npm run docs:check`. Keep the current pin until the new commit can be fetched from the public docs repository.
