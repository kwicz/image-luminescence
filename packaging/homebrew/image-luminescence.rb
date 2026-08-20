# Homebrew formula (tap-ready draft).
#
# To publish: create a tap repo (github.com/kwicz/homebrew-tap), copy this
# file into Formula/, tag a release of image-luminescence (e.g. v1.0.0),
# then fill in the tarball sha256:
#   curl -L https://github.com/kwicz/image-luminescence/archive/refs/tags/v1.0.0.tar.gz | shasum -a 256
# Users then run:
#   brew tap kwicz/tap && brew install image-luminescence
class ImageLuminescence < Formula
  desc "Make images glow on HDR displays; colors preserved exactly"
  homepage "https://kwicz.github.io/image-luminescence/"
  url "https://github.com/kwicz/image-luminescence/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "REPLACE_AFTER_TAGGING"
  license "MIT"

  depends_on "imagemagick"
  depends_on "libultrahdr"
  depends_on "numpy"

  def install
    libexec.install "luminescence.py", "luminescence_pq.py",
                    "luminescence_icc.py", "rec2020-pq-reference.icc"
    python = Formula["numpy"].deps.map(&:name).grep(/^python@/).first || "python@3.13"
    py = Formula[python].opt_bin/"python#{python.split("@").last}"
    (bin/"luminesce").write <<~SH
      #!/bin/bash
      exec "#{py}" "#{libexec}/luminescence.py" "$@"
    SH
    (bin/"luminesce-pq").write <<~SH
      #!/bin/bash
      exec "#{py}" "#{libexec}/luminescence_pq.py" "$@"
    SH
  end

  test do
    system "magick", "-size", "8x8", "xc:white", "#{testpath}/w.png"
    system bin/"luminesce", "#{testpath}/w.png"
    assert_path_exists "#{testpath}/w-luminescence.jpg"
  end
end
