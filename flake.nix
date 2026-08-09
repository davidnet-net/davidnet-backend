{
  description = "davidnet-backend";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs_22
            lsof # for easy port killing eg sudo lsof -t -i:3000 -i:3020 | xargs -r sudo kill -9
          ];

          shellHook = ''
            bun install
            echo "Bun versie: $(bun --version)"
            echo "Node versie: $(node --version)"
          '';
        };
      }
    );
}
