# Houston API

[![Maintainability](https://api.codeclimate.com/v1/badges/fa7e3822ab433568f524/maintainability)](https://codeclimate.com/github/astronomer/houston-api-2/maintainability)
[![Test Coverage](https://api.codeclimate.com/v1/badges/fa7e3822ab433568f524/test_coverage)](https://codeclimate.com/github/astronomer/houston-api-2/test_coverage)

## Description

Houston is the command and control API for the [Astronomer Platform](https://github.com/astronomer/astronomer). It is primarily a [GraphQL](https://graphql.org) server built with [Apollo Server 2](https://www.apollographql.com) and [Prisma](https://www.prisma.io/docs/). It also supports several RESTful endpoints using the same express server that Apollo is using. These endpoints are primarily used for integrating with external authentication, docker registry and other external dependencies. This is the second iteration of this API. This version was built to support the same external API, and is just an internal
re-implementation.

## Database

Houston leverages [Prisma](https://www.prisma.io/docs/) as [GraphQL](https://graphql.org) backend on top of Postgres. The Prisma service sits between Houston and Postgres and exposes a secure CRUD API on top of the Datamodel defined in this project.

## Configuration

Houston can be configured via YAML files under `./config`, and can be overridden via environment variables, which are defined in `/config/custom-environment-variables.yaml`. To add or override any variables locally, create a `.env` file in the project directory.

## Development

Houston is written in es6 and beyond. It's currently built with babel. It's also using a module plugin so imports can be written relative to `./src` and avoid imports like `../../some-module`. Use `npm start` to run the API locally. This uses nodemon and will restart when any source files change. The only exception is `./database/datamodel.graphql`. Changes to this file requies you to restart, triggering a `prisma deploy` and `prisma generate`. We could probably automate that process on change as well.

## Commands

* `npm start` - Start the develpment server. Restarts automatically with nodemon.
* `npm run test` - Runs tests using `jest`.
* `npm run test -- --watch` - Runs tests in watch mode.
* `npm run build` -- Build with babel and place output into `./dist`.
* `npm run playground` - Start a single playground for application as well as prisma CRUD.
