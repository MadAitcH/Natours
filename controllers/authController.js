const crypto = require("crypto");
const { promisify } = require("util");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const catchAsync = require("../utils/catchAsync");
const AppError = require("../utils/appError");
const sendEmail = require("../utils/email");

const signToken = id => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);

  res.status(statusCode).json({
    status: "success",
    token,
    data: {
      user,
    },
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  const { name, email, password, passwordConfirm, role } = req.body;

  const newUser = await User.create({
    name,
    email,
    password,
    passwordConfirm,
    role,
  });

  createSendToken(newUser, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(
      new AppError("Please, provide email and password", 400)
    );
  }

  const user = await User.findOne({ email }).select("+password");

  if (
    !user ||
    !(await user.correctPassword(password, user.password))
  ) {
    return next(new AppError("Incorrect email or password", 401));
  }

  createSendToken(user, 200, res);

  // const token = signToken(user._id);

  // res.status(200).json({
  //   status: "success",
  //   token,
  // });
});

exports.protect = catchAsync(async (req, res, next) => {
  // 1. get token
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(
      new AppError(
        "You're not logged in. Please, log in to get access",
        401
      )
    );
  }

  // 2. verify the token, this will throw error, if the token
  // is not verified
  const decoded = await promisify(jwt.verify)(
    token,
    process.env.JWT_SECRET
  );

  // 3. check if user exists
  const freshUser = await User.findById(decoded.id);
  if (!freshUser) {
    return next(
      new AppError(
        "The user belonging to this token, does no longer exist",
        401
      )
    );
  }

  // 4. check if user changed password after token was issued
  if (freshUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError(
        "User recently changed password. Please log in again",
        401
      )
    );
  }

  // grant access to protected route
  req.user = freshUser;
  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          "You do not have permission to perform this action",
          403
        )
      );
    }
    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const { email } = req.body;
  // 1. Get user based on posted email
  const user = await User.findOne({ email });
  if (!user) {
    return next(
      new AppError(`There's no user with ${email} address`, 404)
    );
  }
  // 2. Generate the random token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });
  // 3. send it to user's email
  const resetURL = `${req.protocol}://${req.get(
    "host"
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password?\nSubmit a new PATCH request with your new password and passwordConfirm to: ${resetURL}\nIf you didn't forget your password, please ignore this email.`;
  try {
    await sendEmail({
      email: user.email,
      subject: "Your password reset token (valid for 10 minutes)",
      message,
    });

    res.status(200).json({
      status: "success",
      message: "Token sent to email",
    });
  } catch (error) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      new AppError(
        `There was an error sending the email. Try again later.`,
        500
      )
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1. get user based on token
  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });
  // 2. if token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError(`Token is invalid or has expired`, 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  // 3. update changedPasswordAt property for the user
  // 4. log the user in, send JWT
  createSendToken(user, 200, res);

  // const token = signToken(user._id);

  // res.status(200).json({
  //   status: "success",
  //   token,
  // });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  const { passwordCurrent } = req.body;
  // 1. get user from collection
  const user = await User.findById(req.user._id).select("+password");
  // 2. check if the posted password is correct (current password)
  if (!(await user.correctPassword(passwordCurrent, user.password))) {
    return next(new AppError("You current password is wrong", 401));
  }
  // 3. if so, update the password
  // User.findByIdAndUpdate will not work as intended
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();
  // 4. log user in, send JWT
  createSendToken(user, 200, res);

  // const token = signToken(user._id);

  // res.status(200).json({
  //   status: "success",
  //   token,
  // });
});