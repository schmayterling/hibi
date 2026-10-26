{
  description = "Desktop editor for local markdown/latex notes and documents";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      base = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      version = "${base}-unstable-${builtins.substring 0 8 self.lastModifiedDate}-${self.shortRev or "dirty"}";
      hibi = pkgs.callPackage ./nix/package.nix { inherit version; };
    in {
      packages.x86_64-linux = {
        default = hibi;
        inherit hibi;
      };

      apps.x86_64-linux.default = {
        type = "app";
        program = "${hibi}/bin/hibi";
      };
    };
}
