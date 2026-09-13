# frozen_string_literal: true

require 'date'
require 'json'
require 'optparse'
require 'rubygems/package'

# Deterministic release checks shared by release PRs and the publishing workflow.
# This script never commits, tags, or publishes anything.
class RubyReleaseValidator
  TAG_PATTERN = /\Av\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\z/

  attr_reader :root, :gem_name, :version_file

  def initialize(root:, gem_name:, version_file:)
    raise 'Invalid gem name' unless /\A[A-Za-z0-9][A-Za-z0-9_.-]*\z/.match?(gem_name)
    raise 'Expected a relative version file path' if version_file.empty? || version_file.start_with?('/') || version_file.split('/').include?('..')

    raise 'Paths must not contain line breaks' if [root, version_file].any? { |path| path.match?(/[\r\n]/) }

    @root = File.expand_path(root)
    @gem_name = gem_name
    @version_file = version_file
  end

  def metadata
    source = File.read(File.join(root, version_file))
    version = source.match(/VERSION\s*=\s*'([^']+)'/)&.[](1)
    date = source.match(/DATE\s*=\s*'([^']+)'/)&.[](1)
    raise 'Missing VERSION or DATE' unless version && date

    manifest = JSON.parse(File.read(File.join(root, '.release-please-manifest.json'))).fetch('.')
    raise 'Manifest and VERSION differ' unless manifest == version

    # Accept both historical headers and Release Please's linked headers.
    header = File.read(File.join(root, 'CHANGELOG.md')).lines.find { |line| line.start_with?('## ') }
    match = header&.match(/^## \[([^\]]+)\](?:\([^)]*\))? (?:- |\()(\d{4}-\d{2}-\d{2})\)?\s*$/)
    raise 'Latest changelog entry does not match VERSION' unless match && match[1] == version

    release_date = match[2]
    Date.iso8601(release_date)
    [version, date, release_date]
  end

  def prepare_date
    _version, current_date, release_date = metadata
    return if current_date == release_date

    path = File.join(root, version_file)
    source = File.read(path)
    File.write(path, source.sub(/(DATE\s*=\s*)'[^']+'/, "\\1'#{release_date}'"))
  end

  def verify(tag = nil)
    version, date, release_date = metadata
    raise 'DATE does not match the changelog; run prepare-date' unless date == release_date

    if tag
      raise 'Invalid release tag' unless TAG_PATTERN.match?(tag)
      raise 'Tag and VERSION differ' unless tag == "v#{version}"
    end

    gem_version = Gem::Version.new(version)
    gem_path = "pkg/#{gem_name}-#{gem_version}.gem"
    package = Gem::Package.new(File.join(root, gem_path))
    package.verify
    spec = package.spec
    raise 'Gem name or version differs from release metadata' unless spec.name == gem_name && spec.version == gem_version

    packaged_source = package.contents.include?(version_file)
    raise 'Gem is missing version.rb' unless packaged_source

    gem_path
  end
end

if $PROGRAM_NAME == __FILE__
  options = { root: Dir.pwd }
  parser = OptionParser.new do |opts|
    opts.banner = 'Usage: release.rb verify|prepare-date --gem-name NAME --version-file PATH [--root DIR] [--tag TAG]'
    opts.on('--gem-name NAME') { |value| options[:gem_name] = value }
    opts.on('--version-file PATH') { |value| options[:version_file] = value }
    opts.on('--root DIR') { |value| options[:root] = value }
    opts.on('--tag TAG') { |value| options[:tag] = value }
  end
  begin
    command = ARGV.shift
    parser.parse!(ARGV)
    raise 'Unexpected arguments' unless ARGV.empty?
    raise 'Both --gem-name and --version-file are required' unless options[:gem_name] && options[:version_file]
    tag = options.delete(:tag)
    validator = RubyReleaseValidator.new(**options)
    case command
    when 'prepare-date'
      raise '--tag is only supported with verify' if tag
      validator.prepare_date
    when 'verify'
      gem_path = File.join(validator.root, validator.verify(tag))
      puts "gem-path=#{gem_path}"
      File.open(ENV['GITHUB_OUTPUT'], 'a') { |file| file.puts "gem-path=#{gem_path}" } if ENV['GITHUB_OUTPUT']
    else
      raise parser.to_s
    end
  rescue StandardError => e
    abort e.message
  end
end
